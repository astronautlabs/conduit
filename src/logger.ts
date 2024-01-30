
export interface RPCLogOptions {
    severity: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
}

export interface RPCLogger {
    log(message: string, options: RPCLogOptions);
}

export class RPCConsoleLogger implements RPCLogger {
    log(message: string, options: { severity: 'debug' | 'info' | 'warning' | 'error' | 'fatal'; }) {
        switch (options.severity) {
            case 'debug':
                console.debug(message);
                break;
            case 'info':
                console.info(message);
                break;
            case 'warning':
                console.warn(message);
                break;
            case 'error':
                console.error(message);
                break;
            case 'fatal':
                console.error(message);
                break;
            default:
                options.severity satisfies never;
        }
    }
}
