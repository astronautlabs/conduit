
/**
 * @internal
 */
export const INTENTIONAL_ERROR = Symbol.for('org.webrpc.intentional-error');

/**
 * When Conduit is in safe exceptions mode (the default), only exceptions thrown via raise() will be directly conveyed
 * to the caller. Otherwise the exceptions will be replaced with an RPCInternalError before being thrown.
 * @param error 
 */
export function raise<T>(error: T): never { 
    error[INTENTIONAL_ERROR] = true;
    throw error; 
}

export class RPCError extends Error {
    constructor(details: { name?: string, message: string, stack: string }) {
        super();
        
        this.name = details.name ?? this.constructor.name;
        this.message = details.message;
        this.stack = details.stack;
    }

    readonly name: string;
    readonly message: string;
    readonly stack: string;

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.stack;
    }
}

export class RPCInternalError extends Error {
    constructor() {
        super(`An internal error has occurred. Please consult the service's logs for more details.`);

        this.name = this.constructor.name;
        this.stack = `${this.constructor.name}: ${this.message}`;
    }
    
    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.stack;
    }
}