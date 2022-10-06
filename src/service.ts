export function Service(identifier: string) {
    return (target) => {
        Reflect.defineMetadata('webrpc:type', 'remotable', target);
        Reflect.defineMetadata('webrpc:service', identifier, target);
    }
}

export function Version(identifier: string) {
    return (target) => {
        Reflect.defineMetadata('webrpc:version', identifier, target);
    }
}