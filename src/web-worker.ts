/// <reference types="reflect-metadata" />

import { PostMessageChannel } from "./channel";
import { Name } from "./name";
import { Remotable } from "./remotable";
import { RPCSession } from "./session";
import { createServiceProxy } from "./service";

/**
 * Represents a constructor function for a Conduit-based WebWorker.
 */
type Constructor<T extends object> = { new(): T };

/**
 * Decorate a class as a Conduit-based Web Worker. 
 * 
 * This overload is compatible with Webpack and other bundlers which 
 * use static code analysis to enable the worker to be placed in its own chunk.
 * 
 * @unstable Caution: This API may change in minor or patch releases until it is marked as stable.
 * @environment Browser only
 * @param workerFactory A function which creates the Worker object. For instance, `() => new Worker(new URL('./my-worker', import.meta.url))`.
 */
export function WebWorker(workerFactory: () => Worker);

/**
 * Decorate a class as a Conduit-based Web Worker.
 * 
 * Caution: This overload is not compatible with Webpack and other bundlers which use static code analysis to 
 * enable the worker to be placed in its own chunk. Instead, use the overload which accepts a `workerFactory`
 * 
 * @unstable Caution: This API may change in minor or patch releases until it is marked as stable.
 * @environment Browser only
 * @param url The URL where this worker can be found when it is loaded from within the browser context. You may be 
 *            able to use `import.meta.url` for this depending on your build system.
 * @param options The options to use when constructing the `Worker` instance.
 */
export function WebWorker(url: string, options?: WorkerOptions);
export function WebWorker(factoryOrUrl: string | (() => Worker), options?: WorkerOptions) {
    const factory = typeof factoryOrUrl === 'string' ? () => new Worker(factoryOrUrl, options) : factoryOrUrl;

    return (target: any) => { 
        Reflect.defineMetadata('conduit:worker:factory', factory, target);
        Name('org.webrpc.worker')(target);
        Remotable()(target);
        if (isWorkerSide()) {
            new RPCSession(new PostMessageChannel(globalThis))
                .registerService(target);
        }
    };
}

/**
 * Create a new instance of the given Conduit-based WebWorker within the current browser environment.
 * 
 * @unstable Caution: This API may change in minor or patch releases until it is marked as stable.
 * @environment Browser only
 * @param workerClass 
 * @returns 
 */
WebWorker.start = function startConduitWorker<T extends object>(workerClass: Constructor<T>) {
    let $webWorker = factoryForConduitWorker(workerClass)();
    let $session = new RPCSession(new PostMessageChannel($webWorker));
    return createServiceProxy(Promise.resolve($session), workerClass, { 
        /**
         * The Conduit RPCSession object associated with this web worker.
         */
        $session,

        /**
         * The Web Platform `Worker` instance, which can be used for low level control of the web worker.
         */
        $webWorker,

        /**
         * Aborts worker's associated global environment.
         * @returns 
         */
        $terminate: () => $webWorker.terminate()
    });
};

function factoryForConduitWorker(workerClass: Constructor<any>) {
    return Reflect.getMetadata('conduit:worker:factory', workerClass) as () => Worker;
};

function isWorkerSide() {
    return typeof globalThis['window'] === 'undefined' && typeof globalThis['WorkerGlobalScope'] !== 'undefined';
}