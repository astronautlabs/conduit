
export interface RemoteRef {
    ['Rε']: string;
    /**
     * The reference ID. This identifies a specific RPCProxy on the remote side. 
     * When encoding, this must always be a fresh GUID.
     */
    Rid?: string;

    /**
     * The side of the connection this reference applies to, from the perspective of 
     * the sender. 'L' means local to the sender, 'R' means remote to the sender.
     */
    S: 'L' | 'R'
}

export function isRemoteRef(obj: any): obj is RemoteRef {
    return obj && typeof obj === 'object' && 'Rε' in obj;
}