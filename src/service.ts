import { firstValueFrom } from "rxjs";
import { DurableSocketChannel, RPCChannel } from "./channel";
import { DurableSocket } from "./durable-socket";
import { AnyConstructor, getRpcServiceName, getRpcUrl } from "./internal";
import { MethodsOf, Proxied, RemoteSubscription } from "./proxied";
import { Remotable } from "./remotable";
import { RPCSession } from "./session";

interface EventSubscription {
    observer: Function;
    remoteSubscription: RemoteSubscription;
}

const SERVICE_PROXY_SESSION = Symbol('SERVICE_PROXY_SESSION');

/**
 * Creates an immediate proxy for a remote service without waiting for:
 * - The channel to be created
 * - The channel to be ready
 * - The RPC session to be created
 * - The RPC service to be acquired
 * 
 * Automatically handles state loss by reacquiring the remote service once connection is ready again, and replaying
 * any active subscription calls.
 * 
 * @internal
 */
export function createServiceProxy<T extends object>(sessionPromise: Promise<RPCSession>, klass: AnyConstructor<T>): Proxied<T> {
    let servicePromise: Promise<Proxied<T>> | undefined;
    let methodTable = new Map<string | symbol, Function>();
    let eventObservers = new Map<string | symbol, EventSubscription[]>();
    let sessionReady: Promise<RPCSession>; // resolves only when the session is ready, value will change over time

    async function acquireService() {
        let service = await (await sessionReady).getRemoteService(klass);

        // Resubscribe to events 
        try {
            for (let [eventName, subscriptions] of eventObservers.entries()) {
                for (let eventSub of subscriptions) {
                    eventSub.remoteSubscription = await service[eventName].subscribe(eventSub.observer);
                }
            }
        } catch (e) {
            throw new Error(`While restoring subscriptions to events after state loss: ${e.stack || e}`);
        }

        return service;
    };

    sessionReady = sessionPromise.then(async session => {
        // Session initialization
        // Needs to run exactly once, but needs to wait for the session to be ready (the first time).
        // As the session transitions from ready to not-ready and back, we'll maintain the sessionReady
        // promise so that new calls can correctly wait for the right state to execute.

        let ready = true;

        session.channel.stateLost.subscribe(() => {
            // Protect against channel types that emit multiple stateLost events before a ready event.
            // If this were to occur without this check, we could resubscribe to events multiple times.
            if (!ready)
                return;

            // Set ourselves up for the next time the connection is ready, including reacquiring the service 
            // as soon as possible (so that we can resubscribe to events).
            ready = false;
            sessionReady = firstValueFrom(session.channel.ready).then(() => session);
            servicePromise = sessionReady.then(() => acquireService());
        });

        session.channel.ready.subscribe(() => ready = true);

        await firstValueFrom(session.channel.ready);
        return session;
    });

    let serviceProvider = async () => {
        let service = await (servicePromise ??= acquireService());
        if (!service)
            throw new Error(`Service.proxy(): No such remote service with ID '${getRpcServiceName(klass)}' (for class ${klass.name})`);
        return service;
    };

    return <Proxied<T>> new Proxy<T>(<any>{}, {
        get(_, p) {
            if (p === SERVICE_PROXY_SESSION)
                return sessionPromise;
            
            if (methodTable.has(p))
                return methodTable.get(p);

            let servicePromise = serviceProvider();
            let method = async (...args) => (await servicePromise)[p](...args);
            method['subscribe'] = async (observer, ...args): Promise<RemoteSubscription> => {
                if (!eventObservers.has(p))
                    eventObservers.set(p, []);

                let observerList = eventObservers.get(p);
                let eventSub: EventSubscription = { 
                    observer, 
                    remoteSubscription: (await servicePromise)[p].subscribe(...args) 
                };

                observerList.push(eventSub);

                return {
                    unsubscribe: async () => {
                        await eventSub.remoteSubscription.unsubscribe();
                        let index = observerList.indexOf(eventSub);
                        if (index >= 0)
                            observerList.splice(index, 1);
                    }
                };
            };

            methodTable.set(p, method);
            return method;
        }
    });
}

/**
 * Provides a powerful and ergonomic way to consume well-known remote objects (services) over Conduit. 
 * 
 * ### Why is this necessary?
 * 
 * When using the lower level RPCSession API, a caller must:
 * - Choose and establish a communication channel (such as DurableSocket) for the communication to occur over
 * - Wait for the communication channel to become ready
 * - Request a remote service object via getRemoteService() and wait for the call to complete
 * 
 * All of the above must occur before the first method call can be sent, and the caller must also maintain the 
 * state of the connection themselves. When the communication channel loses state (for example, when a network 
 * disconnect occurs), the caller must wait for the communication channel to become ready again, acquire a new 
 * service object and otherwise manually restore the state of the connection.
 * 
 * While the lower level API is extremely powerful and allows for communication patterns that are typically not 
 * possible with other RPC systems, it is a lot of manual work to do a job that when using REST communication is 
 * extremely simple.
 * 
 * The Service class takes care of all of this for you and more. 
 * 
 * ### Constraints of using Conduit Services
 * 
 * Effective use requires committing to several assumptions that Conduit itself does *not* make:
 * 
 * - You will communicate over HTTP/Websockets using DurableSocket 
 *   (Conduit itself supports communicating over any arbitrary communication medium, including locally in the same 
 *   process).
 * 
 * - You will primarily adopt a client/server architecture, where the party initiating the connection is the client
 *   and the party receiving the connection is the server.
 *   (Conduit does not require constraining the roles of participants)
 * 
 * - You will primarily make method calls on well-known (service) objects, not transient objects 
 *   (Conduit supports leasing any object across the communication channel along with method calls to those 
 *   transient objects)
 * 
 * - You will use method calls as the primary method of sending data to the server participant, and you will use 
 *   Observable events as your primary method of sending data to the client 
 *   (Conduit itself allows either party to acquire services from the other party and make method calls or event 
 *   subscriptions as they wish)
 * 
 * ### Usage
 * 
 * Servers providing Conduit Services should provide a library component (typically an NPM package)
 * which contains abstract service classes deriving from the Service base class. 
 * - Each class should be decorated with `@Name()` to establish the well-known name for the service over Conduit. 
 * - Each class should be decorated with `@URL()`  to establish the default URL endpoint to connect to.
 * 
 * Clients will acquire a local proxy for a service by calling the static `proxy()` method on the service's class. 
 * Those objects can immediately be used to perform calls or subscribe to events. 
 * 
 * When the first call or event subscription occurs, the service proxy object will:
 * - Acquire or create an appropriate DurableSocketChannel for the configured endpoint URL. If one already exists,
 *   it will be used (only one connection to the server will be established).
 * - Acquire or create an appropriate RPCSession for the configured endpoing URL. If one already exists, 
 *   it will be used (only one session will exist between client/server)
 * - Acquire a Conduit remote proxy for the service
 * 
 * The service object will monitor the underlying channel for stateLost/ready events, and automatically reacquire remote
 * proxies on your behalf. The service object will also automatically maintain local state about event subscriptions and 
 * ensure that the subscriptions are recreated when the connection becomes ready after state loss.
 * 
 * Thus the intricacies of managing a long-lived RPC session while your app is running are abstracted away, letting you
 * simply make calls. Remember that Conduit will automatically reject any pending method calls that are outstanding 
 * when connection loss occurs, allowing you to address that within your normal business logic layer.
 */
@Remotable()
export class Service {
    /**
     * Construct a new proxy for this service pointing at the URL specified by the @URL() decorator.
     * The connection will be established and re-established automatically, the returned service
     * proxy is immediately available for use. Requests to the proxy will be automatically delayed 
     * while the connection is established and the service object is obtained from the remote endpoint.
     * @param socketUrl The URL of the WebSocket server which supports Conduit.
     */
    static proxy<T extends object>(this: AnyConstructor<T>): MethodsOf<T>;

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

        let proxy = createServiceProxy<T>(channelPromise.then(channel => Service.sessionForChannel(channel)), this);

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
     * Retrieve the RPCSession for a given Service object, as returned by Service.proxy()
     * @param service 
     * @returns 
     */
    static sessionForProxy(service: Service): Promise<RPCSession> {
        return service[SERVICE_PROXY_SESSION];
    }

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