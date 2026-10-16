# Hosting research for US and mainland China access

Research date: 2026-10-14. Scope: at most 10 users, a USD 30–60 monthly budget, and a target of losing no more than one hour of saved data after a server failure. This is research and a recommendation; no server has been purchased, deployed, or tested from mainland China.

## Region choice

| Region | Official hosting guidance | Implication for this project |
| --- | --- | --- |
| Hong Kong | Alibaba Cloud and Tencent Cloud distinguish servers outside mainland China from mainland servers for ICP filing. Alibaba lists Hong Kong ECS as `cn-hongkong`; Tencent lists Hong Kong CVM as `ap-hongkong`. | First candidate for a small shared service, subject to tests on the actual users' networks. Geographic proximity alone does not establish reliable access. |
| Singapore | Alibaba lists ECS as `ap-southeast-1`; Tencent lists CVM as `ap-singapore`. It is outside mainland China for the providers' ICP hosting rule. | Alternative if measured US/mainland access and the complete price are better. |
| Mainland China | Both providers state that domain-based websites hosted on mainland servers require ICP filing through the access provider. | Consider after checking filing eligibility and the actual business/data requirements; it adds setup work and still requires US access tests. |

Sources: [Alibaba server/access checks for ICP filing](https://help.aliyun.com/en/icp-filing/basic-icp-service/user-guide/icp-filing-server-access-information-check), [Alibaba ECS regions](https://www.alibabacloud.com/help/en/ecs/user-guide/regions-and-zones), [Tencent CVM regions](https://www.tencentcloud.com/document/product/213/6091), and [Tencent region/ICP FAQ](https://www.tencentcloud.com/document/product/213/17276). The ICP distinction is a hosting requirement, not a promise about reachability or a complete assessment of other applicable obligations.

Alibaba explicitly warns that Simple Application Server instances in Hong Kong and Singapore use international bandwidth and may have high latency from mainland China. Its advertised peak bandwidth is not guaranteed and contention can cause packet loss. Therefore, start with a short subscription and test login, saves, attachment upload/download, and refresh from the actual US and mainland locations at busy times before an annual commitment. Hong Kong being the first candidate is a project recommendation, not a measured finding. [Alibaba creation and network guidance](https://www.alibabacloud.com/help/en/simple-application-server/user-guide/create-a-server).

## Server candidates and price discipline

- **Alibaba Hong Kong Simple Application Server:** a general-purpose 2-vCPU/4-GiB/50-GiB configuration is documented. Check the exact region, family, included traffic, renewal price, and availability in the console. Avoid the **International** family for this use: Alibaba calls its routes “Non-China Optimized” and says the family is unsuitable for mainland users. [Instance families](https://www.alibabacloud.com/help/en/simple-application-server/product-overview/instance-families/).
- **Alibaba Hong Kong ECS:** offers more configuration choices. The price list explicitly excludes system disks and bandwidth; it also says the purchase page determines the actual amount. A compute-only number cannot be treated as a complete monthly quote. [ECS price list](https://www.alibabacloud.com/en/product/ecs-pricing-list/en), [official calculator](https://www.alibabacloud.com/en/pricing-calculator).
- **Tencent Hong Kong CVM:** a comparable VM candidate. Its cost includes instance resources, storage, and public networking, and varies with region and billing method. Confirm a complete Hong Kong Linux configuration in the calculator; avoid reclaimable spot capacity for the sole production writer. [Cost estimation](https://www.tencentcloud.com/document/product/213/15378), [official calculator](https://buy.tencentcloud.com/price/cvm/calculator).

The USD 30–60 budget is a spending limit, not a verified provider quote. Include VM, disks, outbound backup traffic, immutable backup storage/requests, domain renewal, and any tax or currency conversion. Prefer a modest 2-vCPU/4-GiB Linux VM initially; actual attachment growth and save latency determine whether it is sufficient.

## Database and backup recommendation

Use **one active application writer VM** and one authoritative SQLite database initially. The supplied application architecture stores a JSON business aggregate and attachment payloads (`qc_asset_payloads`) in `data/workspace/masterqc-main.sqlite`. Backing up the whole database therefore captures both business data and its stored attachments. Two independently writable regional copies would need a new replication/conflict model; file copying is not that model. Standby restores must stay inactive until the previous writer is stopped or fenced off.

Create a SQLite-aware snapshot every **30 minutes**, validate it, then upload it under a unique timestamped object key. SQLite's Online Backup API produces a consistent completed snapshot while allowing incremental copying; concurrent changes may restart it, and continual writes can prevent completion. Monitor completion and handle busy/error results. Do not treat a raw copy of an actively changing main file as the backup protocol. [SQLite Online Backup API](https://sqlite.org/backup.html).

Track the **source snapshot timestamp** of the newest verified offsite backup, not merely when an upload finished. Alert when it is older than **45 minutes**, so an operator has time to respond before the one-hour objective is exceeded. A 30-minute schedule cannot guarantee that objective during failed jobs, failed uploads, or ignored alarms. Prove recovery into a separate test environment, including attachment retrieval and a representative saved business record, before production cutover.

Keep the offsite bucket in a **separate backup account**, preferably a different provider from the VM, with independent administration/recovery credentials. Give the VM only the permissions needed to upload uniquely named backups and verify them; keep deletion, retention-policy administration, and recovery secrets off the VM. This separation is a project recommendation to reduce the effect of a compromised production account.

Two documented immutable-storage options are:

- **Amazon S3 Object Lock, compliance retention:** protected object versions cannot be overwritten or deleted, including by the account root user, during retention; the retention period cannot be shortened. Account closure is outside that object-delete protection. [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).
- **Alibaba OSS locked WORM retention:** protected objects cannot be modified or deleted, including by the bucket owner. The policy must be locked within its initial 24-hour window; once locked it cannot be deleted or shortened. [OSS retention policies](https://www.alibabacloud.com/help/en/oss/oss-retention-policies).

For an initial seven-day retention, compacted full snapshots of a constant 35-MB database (the 70-MB file is about half free pages) every 30 minutes would produce approximately **50 GB/month of upload traffic** and **12 GB retained** before compression, growth, or extra restore points. These are arithmetic estimates supplied for budget review, not bills or measured compressed sizes. Offsite backups protect against server loss; a local copy or same-VM snapshot alone does not meet that objective.

## SQLite durability limitation

The supplied configuration is `journal_mode=DELETE`, `synchronous=FULL`. SQLite documents that FULL in rollback-journal mode can lose the last committed transaction after a power loss depending on the filesystem. It recommends **EXTRA** when durability is desired: EXTRA also synchronizes the journal directory after DELETE-mode commit. Recommend DELETE + EXTRA for the initial cloud setup, with save-latency verification before rollout. FULL/EXTRA cannot compensate for storage or operating systems that misreport completed flushes, nor for lost disks, account deletion, or logical mistakes. Backups remain necessary. [SQLite synchronous modes](https://sqlite.org/pragma.html#pragma_synchronous), [SQLite storage/flush failure limits](https://sqlite.org/howtocorrupt.html#failure_to_sync).
