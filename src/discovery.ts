import { Name } from "./name";
import { Remotable } from "./remotable";
import { Method } from "./method";
import type { RPCSession } from "./session";

@Name(`org.webrpc.discovery`)
@Remotable()
export class Discovery {
    constructor(readonly session: RPCSession) {

    }

    @Method()
    async findServices() {
        this.session.getRemoteService
    }
}