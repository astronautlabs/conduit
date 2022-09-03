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
            // This is an instance
            target = target.constructor.prototype;
        }
    }
    return Reflect.getMetadata('rpc:type', target, propertyKey) || 'none';
}

export function getRpcServiceName(target: any) {
    return Reflect.getMetadata('rpc:service', target);
}