
export function Event() {
    return (target, propertyKey) => {
        Reflect.defineMetadata('webrpc:type', 'event', target, propertyKey);
    }
}