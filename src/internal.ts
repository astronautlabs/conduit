import { Service } from "./service";

export const OBJECT_ID = Symbol('OBJECT_ID');
export const REFERENCE_ID = Symbol('REFERENCE_ID');

export type Constructor<T = any> = (new (...args: any[]) => T);
export type AbstractConstructor<T = any> = (abstract new (...args: any[]) => T);
export type AnyConstructor<T = any> = Constructor<T> | AbstractConstructor<T>;

/**
 * Get the RPC type assigned to the given target (or property of target).
 * @internal
 * @param target 
 * @param propertyKey 
 * @returns 
 */
 export function getRpcType(target: any, propertyKey?: string): 'service' | 'remotable' | 'event' | 'call' | undefined {
    if (target.prototype instanceof Service)
        return 'remotable';

    if (!target)
        throw new Error(`Cannot get RPC type for undefined/null target`);
    
    try {
        return Reflect.getMetadata('rpc:type', target, propertyKey) 
            ?? Reflect.getMetadata('rpc:type', target.constructor.prototype, propertyKey)
            ?? 'none'
        ;
    } catch (e) {
        debugger;
        throw e;
    }
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcUrl(target: any): string {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return String(Reflect.getMetadata('rpc:url', target));
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcServiceName(target: any): string {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return String(Reflect.getMetadata('rpc:name', target));
}