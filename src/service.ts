import { RPCChannel, SocketChannel } from "./channel";
import { DurableSocket } from "./durable-socket";
import { AnyConstructor, Constructor, getRpcUrl } from "./internal";
import { Proxied } from "./proxied";
import { Remotable } from "./remotable";
import { RPCSession } from "./session";

function immediateServiceProxy<T extends object>(promise: Promise<RPCSession>, klass: AnyConstructor<T>): Proxied<T> {
    let delegate: Promise<Proxied<T>>;

    promise = promise.then(session => {
        session.channel.stateLost.subscribe(() => delegate = undefined);
        return session;
    })

    return asyncProxy<Proxied<T>>(async () => {
        let session = await promise;
        await session.channel.ready.toPromise();
        return delegate ??= session.getRemoteService(klass);
    });
}

function asyncProxy<T extends object>(provider: () => Promise<T>) {
    let functionMap = new Map<string | symbol, Function>();
    return new Proxy<T>(<any>{}, {
        get(_, p) {
            if (!functionMap.has(p))
                functionMap.set(p, async (...args) => (await provider())[p](...args));

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
     * @param socketUrl The URL of the WebSocket server which supports WebRPC.
     */
    static proxy<T extends object>(this: AnyConstructor<T>): Proxied<T>;

    /**
     * Construct a new proxy for this service pointing at the given WebSocket URL.
     * The connection will be established and re-established automatically, the returned service
     * proxy is immediately available for use. Requests to the proxy will be automatically delayed 
     * while the connection is established and the service object is obtained from the remote endpoint.
     * @param socketUrl The URL of the WebSocket server which supports WebRPC.
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
     * Construct a new proxy for this service pointing at the given RPCChannel.
     * The returned service proxy is immediately available for use. Requests to the 
     * proxy will be automatically delayed while the service object is obtained from the 
     * remote endpoint.
     * @param channel The channel to connect to
     */
    static proxy<T extends object>(this: AnyConstructor<T>, channel: RPCChannel): Proxied<T>;
    static proxy<T extends object>(this: AnyConstructor<T>, channel?: string | Promise<RPCChannel> | RPCChannel): Proxied<T> {
        channel ??= getRpcUrl(this);
        
        return immediateServiceProxy<T>(
            (typeof channel === 'string'
                ? new Promise<RPCChannel>(async (resolve, _) => resolve(new SocketChannel(
                    await new DurableSocket(channel as string).waitUntilReady()))
                )
                : Promise.resolve(channel)
            )
            .then(channel => new RPCSession(channel)), 
            this
        );
    }
}

abstract class A extends Service { }