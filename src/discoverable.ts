
/**
 * Specify the discoverability of a registered service. When true (default), the session's
 * `discoverServices()` call will return an entry for this service. When false,
 * the service will not be listed.
 * 
 * @param discoverable Whether the service should be discoverable
 * @returns 
 */
export function Discoverable(discoverable = true) {
    return (target) => {
        Reflect.defineMetadata('rpc:discoverable', discoverable, target);
    }
}