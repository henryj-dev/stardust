---
"stardust": minor
---

Databases get an address outside the cluster and a superuser connection. With `databases.external` set (two IPv4 blocks of one size, the annotation the load balancer reads, and optional labels and annotations), "Create an instance" also commits a LoadBalancer Service `<name>-db` with a fixed cluster IP and one address at the same offset in the other block, at the smallest offset no Service under the databases root holds; "Add an address outside" gives one to an existing instance, or recognises one already written in its directory. Administrators can show a created instance's superuser `DATABASE_URL`, inside the cluster and outside, audited as `databases.reveal` and never cached. New instances run the official PostgreSQL Alpine image pinned by digest (`db-statefulset.images` pins another repository); existing instances keep their image.
