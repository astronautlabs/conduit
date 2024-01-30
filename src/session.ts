/// <reference types="reflect-metadata" />

import { Observable, Subject } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { RPCChannel, SocketChannel } from './channel';
import { DurableSocket } from './durable-socket';
import { inlineRemotable } from './inline-remotable';
import { AnyConstructor, Constructor, getRpcDescription, getRpcDiscoverable, getRpcEvents, getRpcIntrospectable, getRpcMethods, getRpcServiceName, getRpcType, OBJECT_ID, REFERENCE_ID } from './internal';
import { Message } from './message';
import { Method } from './method';
import { Proxied, RemoteSubscription } from './proxied';
import { Remotable } from './remotable';
import { isRemoteRef, RemoteRef } from './remote-ref';
import { isRequest, Request } from './request';
import { isResponse, Response } from './response';
import { RPCProxy } from './rpc-proxy';
import { Name } from './name';
import { RPCConsoleLogger, RPCLogger } from './logger';
import { INTENTIONAL_ERROR, RPCError, RPCInternalError, raise } from './errors';

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

interface RegisteredService<T = any> {
    factory: ServiceFactory<T>;
    description: string;
    discoverable: boolean;
    introspectable: boolean;
    methods: IntrospectedMethod[];
    events: IntrospectedEvent[];
}

export interface IntrospectedEvent {
    name: string;
    simpleType?: SimpleIntrospectedType;
    description?: string;
    //type?: IntrospectedType;
}

export interface DiscoveredService {
    name: string;
    discoverable: boolean;
    introspectable: boolean;
    description: string;
}

export interface IntrospectedMethod {
    name: string;
    parameters?: IntrospectedParameter[];
    description?: string;
    simpleReturnType?: SimpleIntrospectedType;
    //returnType?: IntrospectedType;
}

// export interface IntrospectedType {
//  // TODO
// }

export type SimpleIntrospectedType = 'string' | 'number' | 'bigint' | 'boolean' | 'object' | 'array' | 'void' | 'undefined' | 'null' | 'unknown';

export interface IntrospectedParameter {
    name?: string;
    simpleType?: SimpleIntrospectedType;
    //type?: IntrospectedType;
    description?: string;
}

export interface IntrospectedService extends DiscoveredService {
    methods: IntrospectedMethod[];
    events: IntrospectedEvent[];
}

/**
 * Handles message passing, dispatch, resource management and other concerns for Conduit RPC sessions. Creating a 
 * Session with a given communication channel will enable full remote procedure call functionality on that channel 
 * without any further machination required. 
 */
@Name(`org.webrpc.session`)
@Remotable()
export class RPCSession {
    constructor(readonly channel: RPCChannel) {
        this.registerBuiltinErrors();
        this._remote = RPCProxy.create<RPCSession>(this, getRpcServiceName(RPCSession), '');
        this.registerService(RPCSession, () => this);
        this.registerLocalObject(this, getRpcServiceName(RPCSession));
        channel.received.subscribe(data => {
            let message: Message;
            try {
                message = this.decodeMessage(data);
            } catch (e) {
                this.emitFatalError(new Error(`Failed to decode message. The channel will be closed. Error: ${e.stack || e}`, { cause: e }));
                channel.close?.();
                return;
            }

            this.onReceiveMessage(message, data);
        });
        channel.stateLost?.subscribe(() => {
            Array.from(this._requestMap.values()).forEach(req => {
                req.error = new Error(`The channel state was lost.`)
            });
        });
    }

    /**
     * Whether discovery is allowed on this session. Set to false to globally disable discovery. Note that each 
     * service can also opt out of discovery by using the `@Discovery(false)` decorator.
     */
    enableDiscovery = true;

    /**
     * Whether introspection is allowed on this session. Set to false to globally disable introspection. Note that each 
     * service can also opt out of introspection by using the `@Introspectable(false)` decorator.
     */
    enableIntrospection = true;

    /**
     * When safe exceptions mode is enabled, Conduit will only allow exception information to be sent to the client if 
     * the exception was thrown via the raise() function provided by the @/conduit package. Other exceptions will get 
     * turned into RPCInternalError.
     */
    safeExceptionsMode = true;

    /**
     * When true, stack traces are removed from errors before sending them over the wire.
     */
    maskStackTraces = true;

    /**
     * When true, the client stack trace is added to the end of deserialized errors before they are thrown. 
     */
    addCallerStackTraces = true;

    /**
     * Cause the `fatalErrors` observable to emit the specified error.
     * @param error 
     */
    protected emitFatalError(error: Error) {
        this.logger.log(String(error.stack || error), { severity: 'error' });
        this._fatalErrors.next(error);
    }

    private _fatalErrors = new Subject<Error>();

    /**
     * Receive notifications of fatal errors which cause the session to be ended.
     */
    readonly fatalErrors = this._fatalErrors.asObservable();

    /**
     * Responsible for logging messages out. Default implementation is RPCConsoleLogger, which just uses console.*
     */
    logger: RPCLogger = new RPCConsoleLogger();

    /**
     * Used by lock() and call() to allow delaying requests until some operation is complete.
     */
    private waitChain = Promise.resolve();

    /**
     * Delay further requests on this session until the promise returned by the given function returns.
     * The callback will not execute until previous locks have been completed. 
     * - When Zone.js is available, RPC calls made within the execution context of the callback will be automatically 
     *   *not* delayed by this lock or any others. 
     * - If Zone.js is not available, it is important that you use ignoreLocks() to perform RPC calls when done from an
     *   async completion handler. You do not need to use ignoreLocks() if your callback is synchronous. 
     * 
     * Returns a promise which resolves after all previous locks (and the one created with the given callback) 
     * have been completed
     */
    async lock<T>(callback: () => T): Promise<T> {
        await this.waitChain;

        let returnValue: T;

        if (typeof Zone !== 'undefined') {
            returnValue = this.ignoreLocksAsync(() => callback());
        } else {
            returnValue = this.ignoreLocks(() => callback());
        }

        this.waitChain = this.waitChain.then(() => Promise.resolve(returnValue).then(() => {}));
        
        return await returnValue;
    }

    private _ignoreLocksSync = false;

    /**
     * Ignore the outstanding locks during the (synchronous) execution of the given callback. IMPORTANT: This property
     * does not extend to asynchronous operations performed by this function. If you need that, you need to load Zone.js
     * and use ignoreLocksAsync().
     * @param callback 
     */
    ignoreLocks<T>(callback: () => T): T {
        this._ignoreLocksSync = true;
        try {
            return callback();
        } finally {
            this._ignoreLocksSync = false;
        }
    }

    /**
     * Ignore the outstanding locks during the (asynchronous) execution of the given callback. This function requires
     * Zone.js, if you do not have Zone.js loaded, you must instead use ignoreLocks() at the synchronous moment that you 
     * start an RPC call.
     * 
     * @param callback 
     */
    ignoreLocksAsync<T>(callback: () => T): T {
        if (typeof Zone === 'undefined')
            throw new Error(`Cannot use ignoreLocksAsync() without Zone.js loaded`);

        return Zone.current.fork({
            name: `RPCSession.lock() zone`,
            properties: {
                'conduit:skipRPCLocks': true
            }
        }).run(() => callback());
    }

    /**
     * Connect via WebSocket to the given URL and create a new RPCSession using 
     * the socket as the underlying channel.
     * @param url 
     */
    static async connect(url: string): Promise<RPCSession> {
        return new RPCSession((await new DurableSocket(url).waitUntilReady()).asChannel());
    }

    /**
     * NOTE: The Omit is here to avoid an infinite type recursion-- even though Proxied<T> filters out all 
     * non-async-function properties, it still causes TS to recur. Since we don't need the remote, and the remote 
     * isn't available on the proxy anyway, we can work around the issue by omitting the recursion source.
     */
    private _remote: Proxied<Omit<RPCSession, 'remote'>>;

    /**
     * Retrieve the remote RPCSession for performing direct calls to it over Conduit.
     */
    get remote() { return this._remote; }

    /**
     * Retrieve a proxy for a remote service according to the given service identity.
     * @param serviceIdentity A class which is annotated with `@conduit.Name()`
     * @throws when the remote cannot provide the given service
     */
    async getRemoteService<T>(serviceIdentity: AnyConstructor<T>): Promise<Proxied<T>>
    /**
     * Retrieve a proxy for a remote service according to the given service identity
     * @param serviceIdentity The name of the service to retrieve.
     * @throws when the remote cannot provide the given service
     */
    async getRemoteService<T = any>(serviceIdentity: string): Promise<Proxied<T>>
    async getRemoteService(serviceIdentityOrClass: string | Function): Promise<Proxied<unknown>> {
        if (typeof serviceIdentityOrClass === 'function')
            return this.getRemoteService(getRpcServiceName(serviceIdentityOrClass));
        
        let serviceIdentity: string = serviceIdentityOrClass;
        this.debugLog(`Finding remote service named '${serviceIdentity}...'`);
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
        this.debugLog(`Decoding: ${text}`);
        let postDecoded = JSON.parse(text, (_, v) => isRemoteRef(v) ? this.getObjectByRemoteRef(v) : v);
        this.debugLog(`Decoded:`);
        this.debugLogObject(postDecoded);
        return postDecoded;
    }

    private _requestMap = new Map<string, InFlightRequest>();

    tag: string;

    async call<ResponseT>(receiver: any, method: string, parameters: any[], metadata: Record<string,any> = {}): Promise<ResponseT> {
        if (!receiver)
            throw new Error(`Must provide a receiver object for remote call`);
        if (!(receiver instanceof RPCProxy))
            throw new Error(`Cannot RPC to local object of type '${receiver.constructor.name}'`);

        let clientStackTrace: string;
        if (this.addCallerStackTraces) {
            let stackTraceLimit: number;
            if ('stackTraceLimit' in Error) {
                stackTraceLimit = Error.stackTraceLimit;
                Error.stackTraceLimit += 10;
            }

            try {
                let stackTrace = new Error().stack.split(/\r?\n/).slice(1);
                let index = stackTrace.findIndex(t => t.includes(' RPCSession.call '));
                if (index >= 0) {
                    stackTrace = stackTrace.slice(index + 1);
                }

                clientStackTrace = [ 
                    `    <rpc-call>`,
                    ...stackTrace 
                ].join("\n");
            } finally {
                if ('stackTraceLimit' in Error) {
                    Error.stackTraceLimit = stackTraceLimit;
                }
            }
        }

        let ignoreLocks = this._ignoreLocksSync;
        if (!ignoreLocks && typeof Zone !== 'undefined') {
            ignoreLocks = Zone.current.get('conduit:skipRPCLocks');
        }

        if (!ignoreLocks)
            await this.waitChain;
        
        this.debugLog(`Call: [${receiver.constructor.name}/${receiver[OBJECT_ID]}].${method}()`);

        let rpcRequest = <Request>{
            type: 'request',
            id: uuid(),
            receiver,
            method,
            parameters,
            metadata
        };
        
        this.debugLog(` - Before encoding:`);
        this.debugLogObject(rpcRequest);
        return new Promise<ResponseT>((resolve, reject) => {
            this._requestMap.set(rpcRequest.id, {
                // Save the *original* request that includes local references (not converted to remote references yet)
                request: rpcRequest,
                responseHandler: (response: Response) => {
                    if (response.error) {
                        let error = this.deserializeError(response.error);
                        if (clientStackTrace)
                            error.stack = `${error.stack}\n-- Caller stack trace ---------------\n${clientStackTrace}`;

                        reject(error);
                        return;
                    }
                    resolve(response.value);
                }
            });

            this.rawSend(rpcRequest);
        });
    }

    private errorTypes = new Map<string, (error: any) => any>();

    private registerBuiltinErrors() {
        this.registerErrorType(RPCInternalError);

        this.registerBuiltinErrorType(Error);
        this.registerBuiltinErrorType(EvalError);
        this.registerBuiltinErrorType(RangeError);
        this.registerBuiltinErrorType(ReferenceError);
        this.registerBuiltinErrorType(SyntaxError);
        this.registerBuiltinErrorType(TypeError);
        this.registerBuiltinErrorType(URIError);

        this.registerErrorType(AggregateError, (error: { message: string, errors: unknown }) => {
            let errors: Error[] = [];
            if (error.errors && Array.isArray(error.errors))
                errors = error.errors.map(x => this.deserializeError(x));

            return Object.assign(
                new AggregateError(errors, error.message),
                error,
                { 
                    [Symbol.for('nodejs.util.inspect.custom')]() { 
                        // TODO: This isn't exactly what Node.js does. A default AggregateError shows `stack` and then
                        // attaches the inspect breakdown on the end of that. I'm not exactly sure how it's done, it may
                        // be an entirely custom inspect implementation. Technically we're losing the sub-error stack 
                        // traces with this implementation.
                        return this.stack; 
                    } 
                }
            );
        });
    }

    /**
     * Registers a builtin error class. Usually this is not required, as Conduit registers all the standard builtin 
     * types, but if your Javascript engine supports other nonstandard types, or if there are new types Conduit doesn't
     * handle, you can use this to get them registered.
     * 
     * This is a convenience method that does the right thing (TM) compared to the options available on 
     * registerErrorType(). In particular it ensures that the resulting error instances have the correct inspection 
     * behavior in Node.js.
     * 
     * @param type 
     */
    public registerBuiltinErrorType<T extends Error>(type: Constructor<T>) {
        this.registerErrorType(type, error => {
            return Object.assign(new type(error.message), error, {
                [Symbol.for('nodejs.util.inspect.custom')]() { return this.stack; }
            })
        });
    }

    /**
     * Register an error type so that errors coming over the wire can be reified into the types you are expecting.
     * Note that builtin errors (such as TypeError, ReferenceError etc) are already registered for you.
     * @param type The class constructor. May optionally support a serialize() method for constructing instances
     * @param factory A factory function for creating instances of this class. If unspecified, the static serialize() method
     *                is used. If no serialize() method is available, the constructor itself is used, passing the message as 
     *                the only parameter. After construction, the rest of the properties of the raw error object are assigned
     *                to the resulting instance.
     */
    registerErrorType<T>(type: Constructor<T> & { deserialize?: (error: any) => T }, factory?: (error: any) => T) {
        if ('deserialize' in type) {
            factory ??= error => type.deserialize(error);
        } else {
            factory ??= error => Object.assign(new type(error.message), error);
        }

        this.errorTypes.set(type.name, factory);
    }

    /**
     * Prepare an error for being thrown after being received over the wire.
     * @param error 
     * @returns 
     */
    protected deserializeError(error: { $constructorName: string; name: string; message: string; stack: string; }) {
        if (!error.name)
            return error;

        let errorType = this.errorTypes.get(error.$constructorName) ?? this.errorTypes.get(error.name);
        return errorType?.(error) ?? new RPCError(error);
    }

    /**
     * Prepare an error for going over the wire. Doing this properly is complicated.
     * @param error 
     * @returns 
     */
    protected serializeError(error: any) {
        if (!error.toJSON) {
            if (error instanceof AggregateError) {
                return { 
                    name: error.name,
                    message: error.message, 
                    stack: error.stack, 
                    errors: error.errors.map(e => this.serializeError(e)), 
                    ...error 
                };
            } else if (error instanceof Error) {
                return { 
                    name: error.name, 
                    message: error.message, 
                    stack: error.stack, 
                    $constructorName: error.constructor.name,
                    ...error 
                };
            }
        }

        return error;
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

    private async onReceiveMessage(message: Message, rawData: string) {
        if (isRequest(message)) {
            if (!message.receiver) {
                let rawMessage = JSON.parse(rawData);

                if (rawMessage.receiver) {
                    this.logger.log(`Received invalid request: No such receiver ${JSON.stringify(rawMessage.receive)}!`, { severity: 'error' });
                    this.logger.log(`Message was: ${JSON.stringify(rawData, undefined, 2)}`, { severity: 'error' });

                    this.rawSend(<Response>{
                        type: 'response',
                        id: message.id,
                        error: { code: 'invalid-call', reason: 'no-such-receiver', message: `No such receiver ${JSON.stringify(rawMessage.receive)}` }
                    });
                } else {
                    this.logger.log(`Received invalid request: No receiver specified!`, { severity: 'error' });
                    this.logger.log(`Message was: ${JSON.stringify(rawData, undefined, 2)}`, { severity: 'error' });

                    this.rawSend(<Response>{
                        type: 'response',
                        id: message.id,
                        error: { code: 'invalid-call', reason: 'no-receiver-specified', message: `No receiver specified` }
                    });
                }

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
                    if (this.safeExceptionsMode) {
                        if (!e[INTENTIONAL_ERROR]) {
                            this.logger.log(`Error during ${message.receiver.constructor.name}#${message.method}(): ${e.stack ?? e}`, { severity: 'error' });
                            e = new RPCInternalError();
                        }
                    }
                    error = this.serializeError(e);

                    if (this.maskStackTraces && e instanceof Error && error.stack) {
                        error.stack = `${error.name}${error.message ? `: ${error.message}` : ``}`;
                    }
                }

                this.rawSend(<Response>{
                    type: 'response',
                    id: message.id,
                    value, error
                });

                return;
            } else {
                this.debugLog(`Failed to locate method '${message.method}' on receiver of type ${message.receiver.constructor.name} with ID ${message.receiver[OBJECT_ID]}`);
                this.debugLogObject(message.receiver);
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
                this.logger.log(`Received response to unknown request '${message.id}'`, { severity: 'error' });
                return;
            }

            this.debugLog(`Handling response for request ${message.id}...`);
            this._requestMap.delete(message.id);
            inFlightRequest.responseHandler(message);
            this.onRequestCompleted(inFlightRequest);
            return;
        }

        if (message.type === 'ping') {
            this.rawSend({ type: 'pong' });
            return;
        }

        this.logger.log(`Unknown message type from server '${message.type}'`, { severity: 'error' });
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

    
    private serviceRegistry = new Map<string, RegisteredService>();

    /**
     * Discover the services available on the remote side.
     * @returns 
     */
    async discoverServices(): Promise<DiscoveredService[]> {
        return await this.remote.getDiscoverableServices();
    }

    /**
     * Get the list of services that are discoverable on the local side.
     * @returns 
     */
    @Method()
    async getDiscoverableServices(): Promise<DiscoveredService[]> {
        if (!this.enableDiscovery)
            return [];

        return Array.from(this.serviceRegistry.entries())
            .filter(([name, service]) => service.discoverable)
            .map(([name, service]) => ({ 
                name,
                description: service.description,
                discoverable: service.discoverable,
                introspectable: service.introspectable
            }))
        ;
    }

    /**
     * Introspect the given remote service, if possible.
     * @param name The name of the service
     * @returns 
     */
    async introspectService(klass: Function): Promise<IntrospectedService>;
    async introspectService(name: string): Promise<IntrospectedService>;
    async introspectService(service: Function | string): Promise<IntrospectedService> {
        if (typeof service === 'function')
            service = getRpcServiceName(service);

        return await this.remote.getServiceIntrospection(service);
    }

    /**
     * Return introspection information for the given local service. 
     * @throws when the given service does not exist or is not introspectable.
     * @param name The name of the service
     * @returns 
     */
    @Method()
    async getServiceIntrospection(name: string): Promise<IntrospectedService> {
        let notIntrospectableError = new Error(`Service does not exist or is not introspectable`);

        if (!this.enableIntrospection)
            raise(notIntrospectableError);

        let service = this.serviceRegistry.get(name);
        if (!service?.introspectable)
            raise(notIntrospectableError);

        return {
            name,
            description: service.description,
            discoverable: service.discoverable,
            introspectable: service.introspectable,
            methods: service.methods,
            events: service.events
        }
    }

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
        this.debugLog(`Counted ${count} references to ${id}. Reference list:`);
        this.debugLogObject(Array.from(this.remoteRefRegistry.keys()));
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
        this.debugLog(`Registered local object with ID ${id}`);
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
        this.debugLog(`Creating remote ref for object ${object[OBJECT_ID]}.`);
        this.debugLog(`Determining if this is local (type ${object.constructor.name}):`);
        this.debugLogObject(object);
        if (object instanceof RPCProxy) {
            this.debugLog(` - It is a proxy`);
            // The object is a remote proxy. 
            if (!this.proxyRegistry.has(object[OBJECT_ID])) {
                this.registerProxy(object);
            }

            // Note that we have no Rid (reference ID) here, because 
            // on the remote side it will resolve to the actual object.

            return { 'Rε': object[OBJECT_ID], 'S': 'R' }; // it is remote to US
        } else {
            this.debugLog(` - It is local`);
            if (!this.localObjectRegistry.has(object[OBJECT_ID]))
                this.registerLocalObject(object);
            
            // Create a new reference in our local remoteRefRegistry array.
            // This is a hard reference, ensuring that until the remote side says it's handled this 
            // reference in one way or another (either by using it or by finalizing it), we keep
            // the local object in scope.

            let referenceId = uuid();
            this.debugLog(`Creating reference ${object[OBJECT_ID]}.${referenceId}...`);
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
            this.debugLog(`Resolving proxy ${JSON.stringify(ref)}`);
            // Local to the other side, AKA on this side it is remote (a proxy)
            let weakRef = this.proxyRegistry.get(ref['Rε']);
            object = weakRef?.deref();

            if (object) {
                this.debugLog(`Discarding extra proxy for '${ref['Rε']}'`);
                this.remote.finalizeRef(`${ref['Rε']}.${ref.Rid}`);
            } else {
                // This must be a new object from the remote.
                this.debugLog(`Creating new proxy for '${ref['Rε']}'`);
                object = RPCProxy.create(this, ref['Rε'], ref.Rid);
                this.proxyRegistry.set(ref['Rε'], new WeakRef(object));
            }
        } else if (ref['S'] === 'R') {
            this.debugLog(`Resolving local ${JSON.stringify(ref)}`);
            // Remote to the other side, AKA on this side it is local
            object = this.getLocalObjectById(ref['Rε']);

            if (object === undefined)
                throw new Error(`No such object with ID '${ref['Rε']}'. Did you keep a reference to a dynamic object across a connection loss?`);
        } else {
            throw new Error(`RemoteRef did not specify a side`);
        }

        this.debugLog(`Resolved referenced object to:`);
        this.debugLogObject(object);
        return object;
    }

    debugLoggingEnabled = false;

    private debugLog(message: string) {
        if (this.debugLoggingEnabled)
            this.logger.log(`[${this.tag}] ${message}`, { severity: 'debug' });
    }

    private debugLogObject(obj: any) {
        if (this.debugLoggingEnabled)
            this.logger.log(JSON.stringify(obj, undefined, 2), { severity: 'debug' });
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
    registerService(klass: Constructor);
    registerService(klass: AnyConstructor, factory: ServiceFactory);
    registerService(klass: AnyConstructor, factory?: ServiceFactory) {
        factory ??= () => new (klass as Constructor)();

        if (getRpcType(klass) !== 'remotable')
            throw new Error(`Class '${klass.name}' must extend Service or be marked with @Remotable() to be registered as a service`);
        
        let serviceName = getRpcServiceName(klass);
        let discoverable = getRpcDiscoverable(klass);
        let introspectable = getRpcIntrospectable(klass);

        if (!serviceName)
            throw new Error(`Class '${klass.name}' must be marked with @Name()`);

        if (typeof serviceName !== 'string')
            throw new Error(`Service name must be a string`);

        this.debugLog(`Registering service with ID ${serviceName}...`);
        
        if (this.serviceRegistry.has(serviceName)) {
            throw new Error(
                `Cannot register instance of '${klass.name}' with service name '${serviceName}' ` 
                + `as an instance of '${this.serviceRegistry.get(serviceName).constructor.name}' is already ` 
                + `registered with that name.`
            );
        }

        this.serviceRegistry.set(serviceName, {
            factory,
            description: getRpcDescription(klass),
            discoverable,
            introspectable,
            methods: getRpcMethods(klass),
            events: getRpcEvents(klass)
        });

        this.debugLog(`Registered service with ID ${serviceName}`);
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
        this.debugLog(`Finding local service named '${identity}'...`);

        if (!this.serviceRegistry.has(identity)) {
            this.debugLog(`No service registered with ID '${identity}'`);
            return null;
        }
     
        if (this.localObjectRegistry.has(identity)) {
            this.debugLog(`getLocalService(): Returning an existing service object for ${identity}...`);
            return this.localObjectRegistry.get(identity).deref();
        }
        
        this.debugLog(`getLocalService(): Creating a new service object for ${identity}...`);
        
        let registeredService = this.serviceRegistry.get(identity);
        let serviceObject = registeredService.factory(this);
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
        this.debugLog(`isLocalObjectPresent(): Checking for ${id}...`);
        let weakRef = this.localObjectRegistry.get(id);
        if (weakRef)
            this.debugLog(`isLocalObjectPresent(): Weak ref is present`);
        else
            this.debugLog(`isLocalObjectPresent(): Weak ref is NOT present`);
        
        this.debugLog(`isLocalObjectPresent(): Value is ${!!weakRef.deref() ? 'NOT present' : 'present'}`);
        return !!weakRef.deref();
    }
    
    /**
     * Called by the remote when a proxy has been garbage collected.
     * @param id 
     */
    @Method()
    async finalizeRef(refID: string) {
        if (!this.remoteRefRegistry.has(refID)) {
            this.logger.log(`[conduit.Session] Attempt to finalize reference '${refID}', but it is not known! This is a bug.`, { severity: 'warning' });
        }
            
        this.debugLog(`Deleting reference '${refID}'`);
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

        // If the remote gets disconnected, it's important that we unsubscribe from the local observable
        // to ensure that we do not send next() method calls to an object which has been lost (which would 
        // result in "No receiver specified" errors). We'll also clean up this stateLost subscription if the 
        // observable is manually unsubscribed by the remote.

        if (this.channel.stateLost) {
            subscription.add(this.channel.stateLost.subscribe(() => {
                subscription.unsubscribe();
            }));
        }
        
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