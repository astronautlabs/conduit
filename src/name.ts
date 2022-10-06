
/**
 * Specify the default name for a decorated class. On a Service, this determines 
 * the default service identifier to attach to a class (when it is not overridden
 * during service registration).
 * 
 * @param identifier 
 * @returns 
 */
export function Name(identifier: string) {
    return (target) => {
        Reflect.defineMetadata('rpc:name', identifier, target);
    }
}

/**
 * Specify the default URL for a decorated class. On a Service, this determines
 * the default URL to use when connecting to the service when using the 
 * Service.proxy() method to obtain an immediate-proxy.
 * @param url 
 */
export function URL(url: string) {
    return (target) => {
        Reflect.defineMetadata('rpc:url', url, target);
    }
}