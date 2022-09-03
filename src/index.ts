/// <reference types="reflect-metadata" />

import { Observable, Subject, Subscription } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { EventMessage, isEventMessage } from './event-instance';
import { Message } from './message';
import { Method } from './method';
import { Remotable } from './remotable';
import { isRequest, Request } from './request';
import { isResponse, Response } from './response';
import { getRpcServiceName, getRpcType } from './rpc-metadata';
import { Service } from './service';

export interface Constructor<T = any> {
    new (...args: any[]): T;
}

export interface Peer {
    [name: string]: (...args) => Promise<any>;
}

const OBJECT_ID = Symbol('OBJECT_ID');

function isRemoteRef(obj: any): obj is RemoteRef {
    return obj && typeof obj === 'object' && 'Rε' in obj;
}

function isRemotable(obj: any): boolean {
    return obj && typeof obj === 'object' 
        && (getRpcType(obj.constructor) === 'remotable' || obj instanceof RPCProxy);
}

export class RPCProxy {
    private constructor(id: string) {
        this[OBJECT_ID] = id;
    }

    [OBJECT_ID]?: string;

    static create<T = any>(session: RPCSession, objectId: string): Proxied<T> {
        const methodMap = new Map<string, Function>();

        let proxy: Proxied<T>;
        
        proxy = <Proxied<T>>new Proxy(new RPCProxy(objectId), {
            get(_, p, __) {
                if (p === OBJECT_ID)
                    return objectId;
                if (p === 'toJSON')
                    return () => ({ 'Rε': objectId });
                if (p === 'then')
                    return undefined;
                
                if (!methodMap.has(String(p))) {
                    let method = (...args) => session.call(proxy, String(p), ...args);
                    method['subscribe'] = (observer: (t: any) => void) => {
                        return session.remote.subscribeToEvent(proxy, String(p), inlineRemotable({
                            next: t => observer(t)
                        }));
                    };
                    methodMap.set(String(p), method);
                }
                return methodMap.get(String(p));
            }
        });

        return proxy;
    }
}

export interface RemoteObservable<T = any> {
    subscribe(observer: (t: T) => void): Promise<RemoteSubscription>;
}

export interface RemoteSubscription {
    unsubscribe(): Promise<void>;
}

export function inlineRemotable<T>(object: T): T {
    @Remotable() class InlineRemotable {}
    let instance = <any> new InlineRemotable();
    for (let key of Object.keys(object)) {
        if (typeof object[key] !== 'function')
            continue;
        Reflect.defineMetadata('rpc:type', 'call', InlineRemotable.prototype, key);
        instance[key] = (...args) => {
            let result = object[key](...args);
            if (result instanceof Promise)
                return result;
            return Promise.resolve();
        }
    }

    return instance;
}

type ObservableType<T> =
 T extends null | undefined ? T :
     T extends object & { subscribe(onfulfilled: infer F): any } ?
         F extends ((value: infer V, ...args: any) => any) ?
             V :
             never : 
     T;

type Methods<T> = { [P in keyof T as T[P] extends ((...args) => Promise<any>) ? P : never]: T[P] };
type Events<T> = { [P in keyof T as T[P] extends Observable<any> ? P : never]: RemoteObservable<ObservableType<T[P]>> };
export type Proxied<T> = Methods<T> & Events<T>;

export interface RPCChannel {
    received: Observable<string>;
    send(message: string);
    close?();
}

export class LocalChannel implements RPCChannel {
    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: string) {
        this.otherChannel._received.next(message);
    }
    
    private otherChannel: LocalChannel;

    static makePair(): [ LocalChannel, LocalChannel ] {
        let a = new LocalChannel();
        let b = new LocalChannel();

        a.otherChannel = b;
        b.otherChannel = a;

        return [a, b];
    }
}

export class SocketChannel implements RPCChannel {
    constructor(private socket: WebSocket | RTCDataChannel) {
        socket.addEventListener('message', (ev: MessageEvent<any>) => this._received.next(ev.data));
    }

    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: any) {
        this.socket.send(message)
    }

    close() {
        this.socket.close();
    }
}

export class WindowChannel implements RPCChannel {
    constructor(private remoteWindow: Window, origin?: string) {
        window.addEventListener('message', this.handler = ev => {
            if (origin && ev.origin !== origin)
                return;
            this._received.next(ev.data)
        });
    }

    private handler;
    private _received = new Subject<string>();
    get received() { return this._received.asObservable(); }

    send(message: any) {
        this.remoteWindow.postMessage(message, '*');
    }

    close() {
        window.removeEventListener('message', this.handler);
    }
}

interface RemoteRef {
    ['Rε']: string;
}

export type ServiceFactory<T = any> = (session: RPCSession) => T;

@Service(`org.webrpc.session`)
export class RPCSession {
    constructor(readonly channel: RPCChannel) {
        this._remote = RPCProxy.create<RPCSession>(this, getRpcServiceName(RPCSession));
        this.registerService(RPCSession, () => this);
        this.registerLocalObject(this, getRpcServiceName(RPCSession));
        channel.received.subscribe(data => this.onReceiveMessage(this.decodeMessage(data)));
    }

    private _remote: Proxied<RPCSession>;
    get remote() { return this._remote; }

    async getRemoteService<T = any>(serviceIdentity: string): Promise<Proxied<T>> {
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
        let postDecoded = JSON.parse(text, (_, v) => isRemoteRef(v) ? this.getObjectByRef(v) : v);
        return postDecoded;
    }

    sendEvent<EventT>(receiver: any, name: string, object: EventT) {
        this.rawSend(<EventMessage>{ 
            type: 'event', 
            receiver,
            name, 
            object 
        });
    }

    private _requestMap = new Map<string, (response: any) => void>();

    tag: string;

    call<ResponseT>(receiver: any, method: string, ...parameters: any[]): Promise<ResponseT> {
        if (!receiver)
            throw new Error(`Must provide a receiver object for remote call`);
        if (!(receiver instanceof RPCProxy))
            throw new Error(`Cannot RPC to local object of type '${receiver.constructor.name}'`);

        let rpcRequest = <Request>{
            type: 'request',
            id: uuid(),
            receiver,
            method,
            parameters
        };
        
        return new Promise<ResponseT>((resolve, reject) => {
            this._requestMap.set(rpcRequest.id, (response: Response) => {
                if (response.error)
                    reject(response.error);
                else
                    resolve(response.value);
            });

            this.rawSend(rpcRequest);
        });
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
            if (getRpcType(message.receiver, message.method) === 'call' && typeof message.receiver[message.method] === 'function') {
                let value;
                let error;
                
                try {
                    value = await message.receiver[message.method](...message.parameters);
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
                console.dir(message.receiver);
                this.rawSend(<Response>{
                    type: 'response',
                    id: message.id,
                    error: { code: 'invalid-call', message: `No such method '${message.method}'` }
                });
            }

            return;
        }

        if (isResponse(message)) {
            let handler = this._requestMap.get(message.id);
            if (!handler) {
                console.error(`Received response to unknown request '${message.id}'`);
                return;
            }

            this._requestMap.delete(message.id);
            handler(message);
            return;
        }

        if (isEventMessage(message)) {
            if (this.getRpcType(message.name) === 'event') {
                this[message.name](message.object);
                return;
            } else {
                console.error(`Unsupported event type '${message.name}' received.`);
                return;
            }
        }

        if (message.type === 'ping') {
            this.rawSend({ type: 'pong' });
            return;
        }

        console.error(`Unknown message type from server '${message.type}'`);
    }

    private getRpcType(name: string) {
        return Reflect.getMetadata('rpc:type', this.constructor.prototype, name) || 'none';
    }

    /**
     * Close the related channel, if it supports such an operation.
     */
    close() {
        this.channel.close?.();
    }

    
    private serviceRegistry = new Map<string, ServiceFactory>();
    private localObjectRegistry = new Map<string, any>();

    private registerLocalObject(object: any, id?: string) {
        id ??= object[OBJECT_ID] ?? uuid();
        object[OBJECT_ID] = id;
        this.localObjectRegistry.set(id, object);
    }

    /**
     * Returns a RemoteRef for the given object. The object can be a Remotable object
     * or an RPCProxy object (representing an object remoted from the other side).
     * @param object 
     * @returns 
     */
    remoteRef(object: any): RemoteRef {
        if (!this.localObjectRegistry.has(object[OBJECT_ID]))
            this.registerLocalObject(object);
        return { 'Rε': object[OBJECT_ID] };
    }

    /**
     * Retrieve the local object for the given RemoteRef. The RemoteRef may represent 
     * a Remotable local object or an RPCProxy object for an object remoted from the other side.
     * @param ref 
     * @returns 
     */
    getObjectByRef(ref: RemoteRef) {
        if (!('Rε' in ref) || !ref['Rε'])
            return undefined;
        let object = this.getObjectById(ref['Rε']);
        if (!object) {
            // This must be a new object from the remote.
            object = RPCProxy.create(this, ref['Rε']);
            this.localObjectRegistry.set(ref['Rε'], object);
        }
        return object;
    }

    getObjectById(id: string) {
        return this.localObjectRegistry.get(id);
    }

    registerService(klass: Constructor, factory?: ServiceFactory) {
        factory ??= () => new klass();

        if (getRpcType(klass) !== 'remotable')
            throw new Error(`Class '${klass.name}' must be marked with @Service() to be registered as a service`);
        
        let serviceName = getRpcServiceName(klass);

        if (typeof serviceName !== 'string')
            throw new Error(`Service name must be a string`);
        
        if (this.serviceRegistry.has(serviceName)) {
            throw new Error(
                `Cannot register instance of '${klass.name}' with service name '${serviceName}' ` 
                + `as an instance of '${this.serviceRegistry.get(serviceName).constructor.name}' is already ` 
                + `registered with that name.`
            );
        }

        this.serviceRegistry.set(serviceName, factory);
    }

    /**
     * @internal
     */
    @Method()
    async getLocalService<T>(identity: string): Promise<T> {
        if (!this.serviceRegistry.has(identity)) {
            return null;
        }
     
        if (this.localObjectRegistry.has(identity))
            return this.localObjectRegistry.get(identity);
        
        let serviceObject = this.serviceRegistry.get(identity)(this);
        this.registerLocalObject(serviceObject, identity);
        return serviceObject;
    }

    @Method()
    async subscribeToEvent<T>(eventSource: any, eventName: string, eventReceiver: any) {
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
        
        if (getRpcType(eventSource, eventName) !== 'event')
            throw new Error(`The '${eventName}' property is not an event.`);

        let observable: Observable<any> = eventSource[eventName];

        if (!observable.subscribe) {
            throw new Error(`The '${eventName}' property is not observable.`);
        }

        let subscription = observable.subscribe(value => (eventReceiver as any).next(value));

        return inlineRemotable<RemoteSubscription>({
            unsubscribe: async () => {
                subscription.unsubscribe();
            }
        })
    }
}