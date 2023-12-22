export function Method() {
    return (target, propertyKey) => {
        if (!Reflect.hasMetadata('rpc:methods', target))
            Reflect.defineMetadata('rpc:methods', [], target);

        let methods = Reflect.getMetadata('rpc:methods', target) as string[];
        if (!methods.includes(propertyKey))
            methods.push(propertyKey);
        
        Reflect.defineMetadata('rpc:type', 'call', target, propertyKey);
    }
}