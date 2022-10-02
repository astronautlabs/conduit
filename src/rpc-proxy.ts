import { inlineRemotable } from "./inline-remotable";
import { OBJECT_ID, REFERENCE_ID } from "./internal";
import { Proxied } from "./proxied";
import { RPCSession } from "./session";

export class RPCProxy {
    private constructor(id: string, referenceId: string) {
        this[OBJECT_ID] = id;
        this[REFERENCE_ID] = referenceId;
    }

    [OBJECT_ID]?: string;
    [REFERENCE_ID]?: string;


    static create<T = any>(session: RPCSession, objectId: string, referenceId: string): Proxied<T> {
        const methodMap = new Map<string, Function>();

        let proxy: Proxied<T>;
        
        proxy = <Proxied<T>>new Proxy(new RPCProxy(objectId, referenceId), {
            get(_, p, __) {
                if (p === 'constructor')
                    return RPCProxy;
                if (p === OBJECT_ID)
                    return objectId;
                if (p === REFERENCE_ID)
                    return referenceId;
                if (p === 'toJSON')
                    return () => session.remoteRef(proxy);
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
