
export function Event() {
    return (target, propertyKey) => {
        Reflect.defineMetadata('rpc:type', 'event', target, propertyKey);
    }
}