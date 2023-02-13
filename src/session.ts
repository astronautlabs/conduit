/// <reference types="reflect-metadata" />

import { Observable, Subject } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { RPCChannel, SocketChannel } from './channel';
import { DurableSocket } from './durable-socket';
import { inlineRemotable } from './inline-remotable';
import { AnyConstructor, Constructor, getRpcServiceName, getRpcType, OBJECT_ID, REFERENCE_ID } from './internal';
import { Message } from './message';
import { Method } from './method';
import { Proxied, RemoteSubscription } from './proxied';
import { Remotable } from './remotable';
import { isRemoteRef, RemoteRef } from './remote-ref';
import { isRequest, Request } from './request';
import { isResponse, Response } from './response';
import { RPCProxy } from './rpc-proxy';
import { Name } from './name';

function isRemotable(obj: any): boolean {
    return obj && typeof obj === 'object' 
        && (getRpcType(obj.constructor) === 'remotable' || obj instanceof RPCProxy);
}

export interface InFlightRequest {
    /**
     * It is important that we hold the request, because we must not garbage collect any objects referenced by 
     * the request in the mean time. Normally this isn't possible because there's a hard reference within our 
     * localObjectMap, but if a proxy for this object on the remote side is garbage collected in the mean time, 
     * we may receive a finalizeProxy() request which will cause us to remove it. Holding the request will ensure
     * that it's not possible for the included remotables to be garbage collected as long as the request is in flight.
     */
    request: Request;
    returnValue?: any;
    error?: any;
    responseHandler: (response: any) => void;
}

export type ServiceFactory<T = any> = (session: RPCSession) => T;

/**
 * Handles message passing, dispatch, resource management and other concerns for Conduit RPC sessions. Creating a 
 * Session with a given communication channel will enable full remote procedure call functionality on that channel 
 * without any further machination required. 
 */
@Name(`org.webrpc.session`)
@Remotable()
export class RPCSession {
    constructor(readonly channel: RPCChannel) {
        this._remote = RPCProxy.create<RPCSession>(this, getRpcServiceName(RPCSession), '');
        this.registerService(RPCSession, () => this);
        this.registerLocalObject(this, getRpcServiceName(RPCSession));
        channel.received.subscribe(data => this.onReceiveMessage(this.decodeMessage(data)));
        channel.stateLost?.subscribe(() => {
            Array.from(this._requestMap.values()).forEach(req => {
                req.error = new Error(`The channel state was lost.`)
            });
        });
    }

    /**
     * Connect via WebSocket to the given URL and create a new RPCSession using 
     * the socket as the underlying channel.
     * @param url 
     */
    static async connect(url: string): Promise<RPCSession> {
        return new RPCSession((await new DurableSocket(url).waitUntilReady()).asChannel());
    }

    private _remote: Proxied<RPCSession>;
    get remote() { return this._remote; }

    async getRemoteService<T>(serviceIdentity: AnyConstructor<T>): Promise<Proxied<T>>
    async getRemoteService<T = any>(serviceIdentity: string): Promise<Proxied<T>>
    async getRemoteService(serviceIdentityOrClass: string | Function): Promise<Proxied<any>> {
        if (typeof serviceIdentityOrClass === 'function')
            return this.getRemoteService(getRpcServiceName(serviceIdentityOrClass));
        
        let serviceIdentity: string = serviceIdentityOrClass;
        this.log(`Finding remote service named '${serviceIdentity}...'`);
        return this.remote.getLocalService(serviceIdentity);
    }

    private rawSend(message: Message) {
        this.channel.send(this.encodeMessage(message));
    }

    private encodeMessage(message: Message) {
        let postEncoded = JSON.stringify(message, (_, v) => isRemotable(v) ? this.remoteRef(v) : v);
        return postEncoded;
    }

    private decodeMessage(text: string) {
        this.log(`Decoding: ${text}`);
        let postDecoded = JSON.parse(text, (_, v) => isRemoteRef(v) ? this.getObjectByRemoteRef(v) : v);
        this.log(`Decoded:`);
        this.logObject(postDecoded);
        return postDecoded;
    }

    private _requestMap = new Map<string, InFlightRequest>();

    tag: string;

    async call<ResponseT>(receiver: any, method: string, parameters: any[], metadata: Record<string,any> = {}): Promise<ResponseT> {
        if (!receiver)
            throw new Error(`Must provide a receiver object for remote call`);
        if (!(receiver instanceof RPCProxy))
            throw new Error(`Cannot RPC to local object of type '${receiver.constructor.name}'`);

        this.log(`Call: [${receiver.constructor.name}/${receiver[OBJECT_ID]}].${method}()`);

        let rpcRequest = <Request>{
            type: 'request',
            id: uuid(),
            receiver,
            method,
            parameters,
            metadata
        };
        
        this.log(` - Before encoding:`);
        this.logObject(rpcRequest);
        return new Promise<ResponseT>((resolve, reject) => {
            this._requestMap.set(rpcRequest.id, {
                // Save the *original* request that includes local references (not converted to remote references yet)
                request: rpcRequest,
                responseHandler: (response: Response) => {
                    if (response.error)
                        reject(response.error);
                    else
                        resolve(response.value);
                }
            });

            this.rawSend(rpcRequest);
        });
    }

    protected async performCall(request: Request): Promise<any> {
        if (typeof Zone !== 'undefined') {
            return Zone.current.fork({
                name: 'RPCSessionZone',
                properties: {
                    'rpc:session': this,
                    'rpc:request': request
                }
            }).run(() => request.receiver[request.method](...request.parameters));
        } else {
            return request.receiver[request.method](...request.parameters);
        }
    }

    /**
     * Retrieve the RPCSession that is being served by the current remote method call.
     * This is only available when Zone.js is loaded.
     * @returns 
     */
    static current(): RPCSession {
        if (typeof Zone !== 'undefined') {
            return Zone.current.get('rpc:session');
        }
    }

    static currentRequest() {
        if (typeof Zone !== 'undefined') {
            return Zone.current.get('rpc:request');
        }
    }

    private async onReceiveMessage(message: Message) {
        if (isRequest(message)) {
            if (!message.receiver) {
                console.error(`Received invalid request: No receiver specified!`);
                console.error(`Message was:`);
                console.dir(message);
                
                this.rawSend(<Response>{
                    type: 'response',
                    id: message.id,
                    error: { code: 'invalid-call', message: `No receiver specified` }
                });

                return;
            }

            // The ordering is important here. We *first* check if the property is a method, which would 
            // allow custom proxies to materialize the rpc:type metadata on the fly. 

            let isFunction = typeof message.receiver[message.method] === 'function';
            let rpcType = getRpcType(message.receiver, message.method);
            let allowAll = Reflect.getMetadata('rpc:allow-all-calls', message.receiver);
            if (isFunction && (['call', 'any'].includes(rpcType) || allowAll === true)) {
                let value;
                let error;
                
                try {
                    value = await this.performCall(message);
                } catch (e) {
                    if (e instanceof Error) {
                        error = { message: e.message, stack: e.stack };
                    } else {
                        error = e;
                    }
                }

                this.rawSend(<Response>{
                    type: 'response',
                    id: message.id,
                    value, error
                });

                return;
            } else {
                this.log(`Failed to locate method '${message.method}' on receiver of type ${message.receiver.constructor.name} with ID ${message.receiver[OBJECT_ID]}`);
                this.logObject(message.receiver);
                this.rawSend(<Response>{
                    type: 'response',
                    id: message.id,
                    error: { code: 'invalid-call', message: `No such method '${message.method}'` }
                });
            }

            return;
        }

        if (isResponse(message)) {
            let inFlightRequest = this._requestMap.get(message.id);
            if (!inFlightRequest) {
                console.error(`Received response to unknown request '${message.id}'`);
                return;
            }

            this.log(`Handling response for request ${message.id}...`);
            this._requestMap.delete(message.id);
            inFlightRequest.responseHandler(message);
            this.onRequestCompleted(inFlightRequest);
            return;
        }

        if (message.type === 'ping') {
            this.rawSend({ type: 'pong' });
            return;
        }

        console.error(`Unknown message type from server '${message.type}'`);
    }

    /**
     * Returns true if there are no outstanding requests or remotely held references.
     */
    get idle() {
        return this.pendingRequestCount === 0 && this.remoteReferenceCount === 0;
    }

    /**
     * The number of in-flight requests
     */
    get pendingRequestCount() {
        return this._requestMap.size;
    }

    /**
     * The number of remotely held references
     */
    get remoteReferenceCount() {
        return this.remoteRefRegistry.size;
    }

    private _becameIdle = new Subject<void>();
    private _becameIdle$ = this._becameIdle.asObservable();

    /**
     * Fired when the session has become idle (no pending requests or remote references).
     */
    get becameIdle() { return this._becameIdle$; }

    /**
     * Called when a request is finished processing.
     * @param request 
     */
    onRequestCompleted(request: InFlightRequest) {
        if (this.idle)
            this._becameIdle.next();
    }

    /**
     * Close the related channel, if it supports such an operation.
     */
    close() {
        this.channel.close?.();
    }

    
    private serviceRegistry = new Map<string, ServiceFactory>();

    /**
     * This map tracks individual objects which we've exported via RPC via object ID.
     */
    private localObjectRegistry = new Map<string, WeakRef<any>>();

    /**
     * This map tracks individual *references* sent over the wire. Each time an object is sent over the wire,
     * a new hard reference is created for it on the sender side. Those references must be cleaned up by the remote side
     * using finalizeProxy. Think of each entry in this array as a distinct RPCProxy created on the remote side. 
     * The keys here are `<OBJECTID>.<REFID>`.
     */
    private remoteRefRegistry = new Map<string, any>();

    /**
     * Tracks the known RPCProxy objects allocated on this side of the connection for objects that exist on the remote
     * side.
     */
    private proxyRegistry = new Map<string, WeakRef<any>>();
    
    /**
     * Used to track the lifetimes of remote object proxies for the purpose of releasing the corresponding remote object
     * (once all references have been finalized).
     */
    private proxyFinalizer = new FinalizationRegistry((id: string) => {
        console.log(`Finalizing proxy ${id}`);
        this.proxyRegistry.delete(id);
        setTimeout(() => {
            if (!this.proxyRegistry.has(id))
                this.remote.finalizeRef(id);
        }, this.finalizationDelay);
    });

    /**
     * Determine how many local references are held to the remote object identified by `id`.
     * @param id 
     * @returns 
     */
    countReferencesForObject(id: string) {
        let count = Array.from(this.remoteRefRegistry.keys()).filter(x => x.startsWith(`${id}.`)).length
        this.log(`Counted ${count} references to ${id}. Reference list:`);
        this.logObject(Array.from(this.remoteRefRegistry.keys()));
        return count;
    }

    /**
     * How long to wait after an RPCProxy is finalized before notifying the other side
     * about it. If a new RPCProxy is created before the finalization delay timeout, then
     * the remote finalization will be cancelled. This helps to avoid a situation where the
     * old local proxy can go out of scope and be collected at the same time that a new request 
     * is coming in which will revive it (via a new proxy). 
     */
    finalizationDelay = 1000;

    /**
     * Register the given proxy in the proxy and finalizer registries. This is rquired to ensure 
     * we can identify the proxy by ID later, and that we are properly tracking when the finalization
     * of the given object occurs, so we can notify the remote side.
     * @param object 
     */
    private registerProxy(object: RPCProxy) {
        this.proxyRegistry.set(object[OBJECT_ID], new WeakRef(object));
        this.proxyFinalizer.register(object, `${object[OBJECT_ID]}.${object[REFERENCE_ID]}`);
    }

    /**
     * Register a local object with the given ID (or one will be generated). This is required before 
     * sending references to the local object to the remote side.
     * @param object 
     * @param id 
     */
    private registerLocalObject(object: any, id?: string) {
        id ??= object[OBJECT_ID] ?? uuid();
        object[OBJECT_ID] = id;
        this.localObjectRegistry.set(id, new WeakRef(object));
        this.log(`Registered local object with ID ${id}`);
    }

    /**
     * Returns a RemoteRef for the given object. The object can be a Remotable object
     * or an RPCProxy object (representing an object remoted from the other side). 
     * - If the object is local and remotable, a new reference will be created for the object, 
     *   which MUST be freed later (usually by the remote side). A new reference is *always*
     *   created in this case.
     * - If the object is a remote proxy, we make sure we have registered the proxy, and return
     *   an unallocated reference to the proxy. This is useful for the remote side to identify 
     *   and reassociate the objects it has sent us, when we send that object back to them.
     * @param object 
     * @returns 
     */
    remoteRef(object: any): RemoteRef {
        this.log(`Creating remote ref for object ${object[OBJECT_ID]}.`);
        this.log(`Determining if this is local (type ${object.constructor.name}):`);
        this.logObject(object);
        if (object instanceof RPCProxy) {
            this.log(` - It is a proxy`);
            // The object is a remote proxy. 
            if (!this.proxyRegistry.has(object[OBJECT_ID])) {
                this.registerProxy(object);
            }

            // Note that we have no Rid (reference ID) here, because 
            // on the remote side it will resolve to the actual object.

            return { 'Rε': object[OBJECT_ID], 'S': 'R' }; // it is remote to US
        } else {
            this.log(` - It is local`);
            if (!this.localObjectRegistry.has(object[OBJECT_ID]))
                this.registerLocalObject(object);
            
            // Create a new reference in our local remoteRefRegistry array.
            // This is a hard reference, ensuring that until the remote side says it's handled this 
            // reference in one way or another (either by using it or by finalizing it), we keep
            // the local object in scope.

            let referenceId = uuid();
            this.log(`Creating reference ${object[OBJECT_ID]}.${referenceId}...`);
            this.remoteRefRegistry.set(`${object[OBJECT_ID]}.${referenceId}`, object);
            return { 'Rε': object[OBJECT_ID], 'S': 'L', Rid: referenceId }; // it is local to US
        }
    }

    /**
     * Retrieve the local object for the given RemoteRef. The RemoteRef may represent 
     * a Remotable local object or an RPCProxy object for an object remoted from the other side.
     * @param ref 
     * @returns 
     */
    getObjectByRemoteRef(ref: RemoteRef) {
        if (!('Rε' in ref) || !ref['Rε'])
            return undefined;

        let object: any;

        if (ref['S'] === 'L') {
            this.log(`Resolving proxy ${JSON.stringify(ref)}`);
            // Local to the other side, AKA on this side it is remote (a proxy)
            let weakRef = this.proxyRegistry.get(ref['Rε']);
            object = weakRef?.deref();

            if (object) {
                this.log(`Discarding extra proxy for '${ref['Rε']}'`);
                this.remote.finalizeRef(`${ref['Rε']}.${ref.Rid}`);
            } else {
                // This must be a new object from the remote.
                this.log(`Creating new proxy for '${ref['Rε']}'`);
                object = RPCProxy.create(this, ref['Rε'], ref.Rid);
                this.proxyRegistry.set(ref['Rε'], new WeakRef(object));
            }
        } else if (ref['S'] === 'R') {
            this.log(`Resolving local ${JSON.stringify(ref)}`);
            // Remote to the other side, AKA on this side it is local
            object = this.getLocalObjectById(ref['Rε']);
        } else {
            console.dir(ref);
            throw new Error(`RemoteRef did not specify a side`);
        }

        this.log(`Resolved referenced object to:`);
        this.logObject(object);
        return object;
    }

    loggingEnabled = false;
    private log(message: string) {
        if (this.loggingEnabled)
            console.log(`[${this.tag}] ${message}`);
    }

    private logObject(obj: any) {
        if (this.loggingEnabled)
            console.dir(obj);
    }

    /**
     * Resolve the given ID to a local object, if a local object with that ID exists.
     * @param id 
     * @returns The object if it was registered and not yet garbage collected.
     */
    getLocalObjectById(id: string) {
        return this.localObjectRegistry.get(id)?.deref();
    }

    /**
     * Register a new service on this session. 
     * 
     * When the remote side requests an instance of the service, the factory is called to create the instance. The 
     * factory is passed the Session which is trying to create it, so that an instance of the service can be localized
     * per session, globally, or per call. 
     * 
     * @param klass The class implementing the service
     * @param factory A factory function which can create an instance of the given service. If no factory is provided, 
     *                a default factory is created which constructs the class with default parameters (this means each
     *                session will have a separate instance of the service class).
     */
    registerService(klass: Constructor, factory?: ServiceFactory) {
        factory ??= () => new klass();

        if (getRpcType(klass) !== 'remotable')
            throw new Error(`Class '${klass.name}' must extend Service or be marked with @Remotable() to be registered as a service`);
        
        let serviceName = getRpcServiceName(klass);
        if (!serviceName)
            throw new Error(`Class '${klass.name}' must be marked with @Name()`);

        if (typeof serviceName !== 'string')
            throw new Error(`Service name must be a string`);

        this.log(`Registering service with ID ${serviceName}...`);
        
        if (this.serviceRegistry.has(serviceName)) {
            throw new Error(
                `Cannot register instance of '${klass.name}' with service name '${serviceName}' ` 
                + `as an instance of '${this.serviceRegistry.get(serviceName).constructor.name}' is already ` 
                + `registered with that name.`
            );
        }

        this.serviceRegistry.set(serviceName, factory);
        this.log(`Registered service with ID ${serviceName}`);
    }

    /**
     * Obtain an instance of the given service, by it's identity.  If the service has already been constructed, the 
     * existing instance is used. Otherwise, the factory associated with the service registration will be called,
     * the new instance will be registered, and then returned.
     * 
     * @internal
     */
    @Method()
    async getLocalService<T>(identity: string): Promise<T> {
        this.log(`Finding local service named '${identity}'...`);

        if (!this.serviceRegistry.has(identity)) {
            this.log(`No service registered with ID '${identity}'`);
            return null;
        }
     
        if (this.localObjectRegistry.has(identity)) {
            this.log(`getLocalService(): Returning an existing service object for ${identity}...`);
            return this.localObjectRegistry.get(identity).deref();
        }
        
        this.log(`getLocalService(): Creating a new service object for ${identity}...`);
        let serviceObject = this.serviceRegistry.get(identity)(this);
        this.registerLocalObject(serviceObject, identity);
        return serviceObject;
    }

    /**
     * Get the Conduit ID of the given object, if one has been assigned.
     * @param object Any object- can be a local object or a remote proxy object.
     * @returns 
     */
    getObjectId(object) {
        return object[OBJECT_ID];
    }

    getReferenceId(object) {
        if (!(object instanceof RPCProxy))
            throw new Error(`Reference IDs are only valid on RPCProxy objects`);
        
        return `${object[OBJECT_ID]}.${object[REFERENCE_ID]}`;
    }

    /**
     * Returns true if a local object with the given ID is (1) registered and (2) not garbage collected.
     * @param id 
     * @returns 
     */
    isLocalObjectPresent(id: string) {
        this.log(`isLocalObjectPresent(): Checking for ${id}...`);
        let weakRef = this.localObjectRegistry.get(id);
        if (weakRef)
            this.log(`isLocalObjectPresent(): Weak ref is present`);
        else
            this.log(`isLocalObjectPresent(): Weak ref is NOT present`);
        
        this.log(`isLocalObjectPresent(): Value is ${!!weakRef.deref() ? 'NOT present' : 'present'}`);
        return !!weakRef.deref();
    }
    
    /**
     * Called by the remote when a proxy has been garbage collected.
     * @param id 
     */
    @Method()
    async finalizeRef(refID: string) {
        if (!this.remoteRefRegistry.has(refID)) {
            console.warn(`[webrpc.Session] Attempt to finalize reference '${refID}', but it is not known! This is a bug.`);
        }
            
        this.log(`Deleting reference '${refID}'`);
        this.remoteRefRegistry.delete(refID);
        if (this.idle)
            this._becameIdle.next();
    }

    /**
     * Subscribe to an event (named `eventName`) on the given object (`eventSource`). This method is typically called 
     * over Conduit by the remote side. It is not intended to be used on a local (non-proxied) instance of RPCSession.
     * 
     * Constraints:
     * - The given `eventSource` must be remote from the caller's perspective (local from the perspective of the implementation).
     * - The given `eventReceiver` must be local from the caller's perspective (remote from the perspective of the implementation).
     * 
     * The `eventSource` object should have an `eventName` property which contains an `Observable`. That observable will
     * be subscribed to, and the resulting emitted values will be passed to `eventReceiver` via it's `next()` method.
     * 
     * @param eventSource 
     * @param eventName 
     * @param eventReceiver 
     * @returns 
     */
    @Method()
    async subscribeToEvent<T>(eventSource: any, eventName: string, eventReceiver: { next(value: T): void }) {
        if (!eventSource)
            throw new TypeError(`eventSource cannot be null/undefined`);
        
        if (typeof eventName !== 'string')
            throw new TypeError(`eventName must be a string`);

        if (!eventReceiver)
            throw new TypeError(`eventReceiver cannot be null/undefined`);
        
        if (eventSource instanceof RPCProxy)
            throw new Error(`[${this.tag}] eventSource must be a remote object`); // audience of this message is the remote side here
        
        if (!(eventReceiver instanceof RPCProxy))
            throw new Error(`eventReceiver must be a local object`); // audience of this message is the remote side here
        
        // The ordering is important here. We *first* get the property, which would 
        // allow custom proxies to materialize the rpc:type metadata on the fly. 

        let observable: Observable<any> = eventSource[eventName];
        let rpcType = getRpcType(eventSource, eventName);
        let allowAll = Reflect.getMetadata('rpc:allow-all-calls', eventSource);

        if (!['event', 'any'].includes(rpcType) && allowAll !== true)
            throw new Error(`The '${eventName}' property is not an event.`);

        if (!observable.subscribe) {
            throw new Error(`The '${eventName}' property is not observable.`);
        }

        let subscription = await observable.subscribe(value => (eventReceiver as any).next(value));

        return inlineRemotable<RemoteSubscription>({
            unsubscribe: async () => {
                subscription.unsubscribe();
            }
        })
    }

    /**
     * This is used for testing.
     * @internal
     */
    getRequestMap() {
        return this._requestMap;
    }

    /**
     * This is used for testing.
     * @internal
     */
    finalizeProxy(proxy) {
        if (!(proxy instanceof RPCProxy))
            throw new Error(`Argument must be an RPCProxy`);
        this.finalizeRef(`${proxy[OBJECT_ID]}.${proxy[REFERENCE_ID]}`);
    }
}