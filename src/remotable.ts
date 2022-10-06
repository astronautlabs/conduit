export function Remotable() {
    return (target) => {
        Reflect.defineMetadata('webrpc:type', 'remotable', target);
    }
}