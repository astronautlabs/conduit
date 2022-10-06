
export function Name(identifier: string) {
    return (target) => {
        Reflect.defineMetadata('rpc:name', identifier, target);
    }
}
