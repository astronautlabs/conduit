export function Method() {
    return (target, propertyKey) => {
        if (!Reflect.hasMetadata('rpc:methods', target.constructor))
            Reflect.defineMetadata('rpc:methods', [], target.constructor);

        let methods = Reflect.getMetadata('rpc:methods', target.constructor) as string[];
        if (!methods.includes(propertyKey))
            methods.push(propertyKey);
        
        Reflect.defineMetadata('rpc:type', 'call', target, propertyKey);
    }
}