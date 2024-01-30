
export function Event() {
    return (target, propertyKey) => {
        if (!Reflect.hasMetadata('rpc:events', target.constructor))
            Reflect.defineMetadata('rpc:events', [], target.constructor);

        let methods = Reflect.getMetadata('rpc:events', target.constructor) as string[];
        if (!methods.includes(propertyKey))
            methods.push(propertyKey);
        
        Reflect.defineMetadata('rpc:type', 'event', target, propertyKey);
    }
}