import { Remotable } from "./remotable";

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

/**
 * Instruct Conduit to allow all method calls and event subscriptions on 
 * the given object. This is useful when creating custom proxies, as well 
 * as when passing an object from one RPC session to another (ie relaying).
 * @param object 
 * @returns 
 */
export function bypassSecurityAllowAllCalls<T>(object: T): T {
    Reflect.defineMetadata('rpc:allow-all-calls', true, object);
    return object;
}