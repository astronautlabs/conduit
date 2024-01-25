import { firstValueFrom } from "rxjs";
import { DurableSocketChannel, RPCChannel, SocketChannel } from "./channel";
import { DurableSocket } from "./durable-socket";
import { AnyConstructor, getRpcServiceName, getRpcUrl } from "./internal";
import { Proxied } from "./proxied";
import { Remotable } from "./remotable";
import { RPCSession } from "./session";

function immediateServiceProxy<T extends object>(promise: Promise<RPCSession>, klass: AnyConstructor<T>): Proxied<T> {
    let servicePromise: Promise<Proxied<T>>;

    promise = promise.then(session => {
        session.channel.stateLost.subscribe(() => servicePromise = undefined);
        return session;
    })

    return asyncProxy<Proxied<T>>(async () => {
        let session = await promise;
        await firstValueFrom(session.channel.ready);
        let service = await (servicePromise ??= session.getRemoteService(klass));
        if (!service)
            throw new Error(`Service.proxy(): No such remote service with ID '${getRpcServiceName(klass)}' (for class ${klass.name})`);
        return service;
    });
}

function asyncProxy<T extends object>(provider: () => Promise<T>) {
    let functionMap = new Map<string | symbol, Function>();
    return new Proxy<T>(<any>{}, {
        get(_, p) {
            if (!functionMap.has(p))
                functionMap.set(p, async (...args) => {
                    const object = await provider();
                    if (!object) {
                        throw new Error(`asyncProxy: Provider failed to produce a viable object during call to ${String(p)}()`);
                    }

                    return object[p](...args);
                });

            return functionMap.get(p);
        }
    });
}

@Remotable()
export class Service {
    /**
     * Construct a new proxy for this service pointing at the URL specified by the @URL() decorator.
     * The connection will be established and re-established automatically, the returned service
     * proxy is immediately available for use. Requests to the proxy will be automatically delayed 
     * while the connection is established and the service object is obtained from the remote endpoint.
     * @param socketUrl The URL of the WebSocket server which supports Conduit.
     */
    static proxy<T extends object>(this: AnyConstructor<T>): Proxied<T>;

    /**
     * Construct a new proxy for this service pointing at the given WebSocket URL.
     * The connection will be established and re-established automatically, the returned service
     * proxy is immediately available for use. Requests to the proxy will be automatically delayed 
     * while the connection is established and the service object is obtained from the remote endpoint.
     * @param socketUrl The URL of the WebSocket server which supports Conduit.
     */
    static proxy<T extends object>(this: AnyConstructor<T>, socketUrl: string): Proxied<T>;
    
    /**
     * Construct a new proxy for this service pointing at the given RPCChannel.
     * The returned service proxy is immediately available for use. Requests to the 
     * proxy will be automatically delayed while the channel promise is resolved and the 
     * service object is obtained from the remote endpoint.
     * @param channel A promise for obtaining the channel to use
     */
    static proxy<T extends object>(this: AnyConstructor<T>, channel: Promise<RPCChannel>): Proxied<T>;

    /**
     * Construct a new proxy for the service identified by this class, which is running remotely on the 
     * other side of the given RPCChannel. 
     * 
     * If channelOrEndpoint is a string, it is treated as a WebSockets URL, and a new durable WebSocket channel 
     * connection will be created. If a connection to the endpoint already exists, the connection will be reused.
     * 
     * The returned service proxy is immediately available for use without awaiting. Requests to the 
     * proxy will be automatically delayed while the service object is obtained from the 
     * remote endpoint. 
     * 
     * @param channel The channel to connect to
     */
    static proxy<T extends object>(this: AnyConstructor<T>, channel: RPCChannel): Proxied<T>;
    static proxy<T extends object>(this: AnyConstructor<T>, channelOrEndpoint?: string | Promise<RPCChannel> | RPCChannel): Proxied<T> {
        channelOrEndpoint ??= getRpcUrl(this);
        
        let channelPromise: Promise<RPCChannel>;

        if (typeof channelOrEndpoint === 'string') {
            let endpointChannel = Service.channelForEndpoint(channelOrEndpoint);
            channelPromise = endpointChannel.socket.waitUntilReady().then(() => endpointChannel);
        } else {
            channelPromise = Promise.resolve(channelOrEndpoint);
        }

        let proxy = immediateServiceProxy<T>(channelPromise.then(channel => Service.sessionForChannel(channel)), this);

        if (typeof channelOrEndpoint === 'string') {
            Reflect.defineMetadata('rpc:endpoint', channelOrEndpoint, proxy);
        }

        return proxy;
    }

    static endpointOf(service): string {
        return Reflect.getMetadata('rpc:endpoint', service);
    }

    private static channelSessions = new WeakMap<RPCChannel, RPCSession>();

    /**
     * Acquire the RPCSession object associated with the given channel. This will be the same session used 
     * by Service.proxy() when used in concert with the given channel.
     * @param channel 
     * @returns 
     */
    static sessionForChannel(channel: RPCChannel) {
        if (this.channelSessions.has(channel))
            return this.channelSessions.get(channel);

        const session = new RPCSession(channel);
        this.channelSessions.set(channel, session);

        return session;
    }

    private static endpointChannels = new Map<string, WeakRef<DurableSocketChannel>>();
    
    /**
     * Get or create the RPCChannel object associated with the given endpoint URL. This will be the same channel
     * used by Service.proxy() when used in concert with the given endpoint URL.
     * @param channel 
     * @returns 
     */
    static channelForEndpoint(endpoint: string) {
        let channel = this.endpointChannels.get(endpoint)?.deref();
        if (channel) {
            return channel;
        } else {
            this.endpointChannels.set(
                endpoint, 
                new WeakRef(channel = new DurableSocketChannel(new DurableSocket(endpoint)))
            );
        }
        
        return channel;
    }
}