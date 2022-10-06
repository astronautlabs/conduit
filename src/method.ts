export function Method() {
    return (target, propertyKey) => {
        Reflect.defineMetadata('webrpc:type', 'call', target, propertyKey);
    }
}