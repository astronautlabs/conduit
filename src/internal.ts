import { getParameterNames } from "./get-param-names";
import { Service } from "./service";
import { IntrospectedEvent, IntrospectedMethod, SimpleIntrospectedType } from "./session";

export const OBJECT_ID = Symbol('OBJECT_ID');
export const REFERENCE_ID = Symbol('REFERENCE_ID');

export type Constructor<T = any> = (new (...args: any[]) => T);
export type AbstractConstructor<T = any> = (abstract new (...args: any[]) => T);
export type AnyConstructor<T = any> = Constructor<T> | AbstractConstructor<T>;

/**
 * Get the RPC type assigned to the given target (or property of target).
 * @internal
 * @param target 
 * @param propertyKey 
 * @returns 
 */
 export function getRpcType(target: any, propertyKey?: string): 'service' | 'remotable' | 'event' | 'call' | undefined {
    if (target.prototype instanceof Service)
        return 'remotable';

    if (!target)
        throw new Error(`Cannot get RPC type for undefined/null target`);
    
    try {
        return Reflect.getMetadata('rpc:type', target, propertyKey) 
            ?? Reflect.getMetadata('rpc:type', target.constructor.prototype, propertyKey)
            ?? 'none'
        ;
    } catch (e) {
        debugger;
        throw e;
    }
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcUrl(target: any): string {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return String(Reflect.getMetadata('rpc:url', target));
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcServiceName(target: any): string {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return String(Reflect.getMetadata('rpc:name', target));
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcDiscoverable(target: any): boolean {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return Boolean(Reflect.getMetadata('rpc:discoverable', target) ?? true);
}

export function getRpcEvents(target: any): IntrospectedEvent[] {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    let events: IntrospectedEvent[] = [];

    for (let name of Reflect.getMetadata('rpc:events', target) ?? []) {
        events.push({
            name,
            description: getRpcDescription(target.prototype, name)
        })
    }

    return events;
}

export function getRpcDescription(target: any, propertyKey?: string) {
    return Reflect.getMetadata('rpc:description', target, propertyKey);
}

export function getRpcMethods(target: any): IntrospectedMethod[] {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    let methods: IntrospectedMethod[] = [];

    for (let name of Reflect.getMetadata('rpc:methods', target) ?? []) {
        let paramTypes = Reflect.getMetadata('design:paramtypes', target.prototype, name);
        let paramNames = getParameterNames(target.prototype[name]);
        let paramDescriptions = Reflect.getMetadata('rpc:paramDescriptions', target.prototype, name) ?? [];

        methods.push({
            name,
            description: getRpcDescription(target.prototype, name),
            simpleReturnType: simplifyType(Reflect.getMetadata('design:returntype', target.prototype, name)),
            parameters: paramNames.map((name, i) => ({ 
                name,
                simpleType: simplifyType(paramTypes[i]),
                description: paramDescriptions[i]
            }))
        })
    }

    return methods;
}

function simplifyType(type: Function): SimpleIntrospectedType {
    switch (type) {
        case undefined: return 'void';
        case null: return 'null';
        case Number: return 'number';
        case String: return 'string';
        case Boolean: return 'boolean';
        case BigInt: return 'bigint';
        case Array: return 'array';
        case Object: return 'object';
    }
    
    return 'unknown';
}

/**
 * @internal
 * @param target 
 * @returns 
 */
export function getRpcIntrospectable(target: any): boolean {
    if (typeof Reflect === 'undefined')
        return undefined;
    
    return Boolean(Reflect.getMetadata('rpc:introspectable', target) ?? true);
}