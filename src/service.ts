export function Service(identifier: string) {
    return (target) => {
        Reflect.defineMetadata('rpc:type', 'remotable', target);
        Reflect.defineMetadata('rpc:service', identifier, target);
    }
}