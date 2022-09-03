export function Method() {
    return (target, propertyKey) => {
        Reflect.defineMetadata('rpc:type', 'call', target, propertyKey);
    }
}