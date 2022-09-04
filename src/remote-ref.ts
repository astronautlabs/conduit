
export interface RemoteRef {
    ['Rε']: string;
    /**
     * The reference ID. This identifies a specific RPCProxy on the remote side. 
     * When encoding, this must always be a fresh GUID.
     */
    Rid?: string;
    S: 'L' | 'R'
}

export function isRemoteRef(obj: any): obj is RemoteRef {
    return obj && typeof obj === 'object' && 'Rε' in obj;
}