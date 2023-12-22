
/**
 * Specify the introspectability of a registered service. When true (default), the session's
 * `introspectService()` call will return information about the methods and events available on 
 * the service object. When false, the call will fail.
 * 
 * Note that this is independent from discoverability- if a service is not discoverable but is introspectable,
 * the introspectService() call can still be used on it
 * 
 * @param introspectable Whether the service should be introspectable
 * @returns 
 */
export function Introspectable(introspectable = true) {
    return (target) => {
        Reflect.defineMetadata('rpc:introspectable', introspectable, target);
    }
}