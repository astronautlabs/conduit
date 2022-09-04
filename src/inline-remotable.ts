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
