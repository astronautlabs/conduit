import { Observable } from "rxjs";
import { RPCProxy } from "./rpc-proxy";

export interface RemoteObservable<T = any> {
    subscribe(observer: (t: T) => void): Promise<RemoteSubscription>;
}

export interface RemoteSubscription {
    unsubscribe(): Promise<void>;
}

type ObservableType<T> =
 T extends null | undefined ? T :
     T extends object & { subscribe(onfulfilled: infer F): any } ?
         F extends ((value: infer V, ...args: any) => any) ?
             V :
             never : 
     T;
export type MethodsOf<T> = { [P in keyof T as T[P] extends ((...args) => Promise<any>) ? P : never]: T[P] };
export type EventsOf<T> = { [P in keyof T as T[P] extends Observable<any> ? P : never]: RemoteObservable<ObservableType<T[P]>> };
export type Proxied<T> = MethodsOf<T> & EventsOf<T>;

export function markProxied<T>(value: T | Proxied<T>): Proxied<T> {
    return <Proxied<T>> <unknown> value;
}