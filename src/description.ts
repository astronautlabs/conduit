
/**
 * Specify the discoverability of a registered service. When true (default), the session's
 * `discoverServices()` call will return an entry for this service. When false,
 * the service will not be listed.
 * 
 * @param discoverable Whether the service should be discoverable
 * @returns 
 */
export function Description(description: string) {
    return (target, propertyKey?: string, paramIndex?: number | PropertyDescriptor) => {
        if (typeof paramIndex === 'number') {
            if (!Reflect.hasMetadata('rpc:paramDescriptions', target, propertyKey))
                Reflect.defineMetadata('rpc:paramDescriptions', [], target, propertyKey);

            let paramDescriptions = Reflect.getMetadata('rpc:paramDescriptions', target, propertyKey);
            paramDescriptions[paramIndex] = description;
        }
        Reflect.defineMetadata('rpc:description', description, target, propertyKey);
    }
}

class Foo {
    bar(@Description('blah') cool: number) {

    }
}