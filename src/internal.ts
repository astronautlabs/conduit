export const OBJECT_ID = Symbol('OBJECT_ID');
export const REFERENCE_ID = Symbol('REFERENCE_ID');

export type Constructor<T = any> = (new (...args: any[]) => T);
export type AbstractConstructor<T = any> = (abstract new (...args: any[]) => T);
export type AnyConstructor<T = any> = Constructor<T> | AbstractConstructor<T>;

/**
 * Get the RPC type assigned to the given target (or property of target).
 * @param target 
 * @param propertyKey 
 * @returns 
 */
 export function getRpcType(target: any, propertyKey?: string) {
    if (!target)
        throw new Error(`Cannot get RPC type for undefined/null target`);
        
    if (propertyKey) {
        if (target.constructor.prototype !== target) {
            if (!target.constructor.prototype) {
                throw new Error(`BUG: Should not hit this`);
            }
            // This is an instance
            target = target.constructor.prototype;
        }
    }

    try {
        return Reflect.getMetadata('rpc:type', target, propertyKey) || 'none';
    } catch (e) {
        debugger;
        throw e;
    }
}

export function getRpcServiceName(target: any) {
    return Reflect.getMetadata('rpc:service', target);
}