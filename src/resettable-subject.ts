import { PartialObserver, Subject, Subscription } from "rxjs";
import { startWith } from 'rxjs/operators';

export class ResettableReplaySubject<T> extends Subject<T> {
    private _buffer: (T | number)[] = [];
    private _emitter = new Subject<T>();

    /**
     * @param bufferSize The size of the buffer to replay on subscription
     * @param windowTime The amount of time the buffered items will say buffered
     * @param timestampProvider An object with a `now()` method that provides the current timestamp. This is used to
     * calculate the amount of time something has been buffered.
     */
    constructor(private _bufferSize = Infinity) {
        super();
        this._bufferSize = Math.max(1, _bufferSize);
    }

    next(value: T): void {
        const { isStopped, _buffer } = this;
        if (!isStopped)
            _buffer.push(value);
        this._trimBuffer();
        this._emitter.next(value);
    }

    reset() {
        this._buffer = [];
    }

    subscribe(observer?: PartialObserver<T>): Subscription;
    /** @deprecated Use an observer instead of a complete callback */
    subscribe(next: null | undefined, error: null | undefined, complete: () => void): Subscription;
    /** @deprecated Use an observer instead of an error callback */
    subscribe(next: null | undefined, error: (error: any) => void, complete?: () => void): Subscription;
    /** @deprecated Use an observer instead of a complete callback */
    subscribe(next: (value: T) => void, error: null | undefined, complete: () => void): Subscription;
    subscribe(next?: (value: T) => void, error?: (error: any) => void, complete?: () => void): Subscription;
    override subscribe(...args): Subscription {
        if (this._buffer.length > 0)
            return this._emitter.pipe(startWith(...this._buffer.slice())).subscribe(...args);
        else
            return this._emitter.subscribe(...args);
    }

    private _trimBuffer() {
        const { _bufferSize, _buffer } = this;
        _bufferSize < Infinity && _bufferSize < _buffer.length && _buffer.splice(0, _buffer.length - _bufferSize);
    }
}