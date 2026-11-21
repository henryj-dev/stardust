---
"stardust": minor
---

A component can get an address outside the cluster from its page: a
LoadBalancer Service `<component>-vip` with a fixed cluster IP and one address
at the same offset of the blocks in `runtime.external`, carrying the
configured labels and annotations (such as DSR). The offset is picked so that
no Service anywhere in the deploy repository, no database's address and
(when it can be listed) nothing in the cluster holds it, and a Service of the
same name is refused. With `runtime.external` set, scaffolding no longer
commits a plain LoadBalancer.
