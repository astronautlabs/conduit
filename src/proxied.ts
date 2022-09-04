import { Observable } from "rxjs";

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
type Methods<T> = { [P in keyof T as T[P] extends ((...args) => Promise<any>) ? P : never]: T[P] };
type Events<T> = { [P in keyof T as T[P] extends Observable<any> ? P : never]: RemoteObservable<ObservableType<T[P]>> };
export type Proxied<T> = Methods<T> & Events<T>;
