export function Remotable() {
    return (target) => {
        Reflect.defineMetadata('rpc:type', 'remotable', target);
    }
}