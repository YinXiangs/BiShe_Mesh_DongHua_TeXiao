# 启用跨设备提交与老师免登录评审

GitHub Pages 托管网页；Supabase 保存模型、视频、版本和意见。未配置云服务时，网站使用当前浏览器的本地草稿，老师在另一台设备无法看到这些草稿。FBX 和 MP4 不需要提交到 GitHub 仓库。以下配置完成并实际联测后，才能给老师发送可用的评审链接。

## 1. 建立数据库

在自己的 Supabase 账户中创建一个新项目，在 SQL Editor 执行本目录的 `schema.sql`。脚本创建项目表、版本表、意见表、成员表、分享链接表和私有文件桶 `review-files`。适用于新项目；不要将本脚本直接用于已有同名但结构不同的数据库。

所有业务表启用行级权限。匿名用户不能直接读取业务表、调用分享 SQL 函数或访问文件桶。前端公开密钥不是身份凭证，不能绕过这些权限。文件桶必须保持 **Private**。

## 2. 建立项目所有者

在 Authentication → Users 中创建或邀请自己的邮箱，复制该用户的 UUID，在 SQL Editor 执行：

```sql
insert into public.review_members(user_id, role)
values ('将此处替换为自己的真实用户UUID', 'owner');
```

这是管理员操作。网站不提供自助注册或提升权限。网页邮箱登录只向已存在的账户发送登录链接。

在 Authentication 的 URL Configuration 中设置：

```text
Site URL: https://yinxiangs.github.io/BiShe_Mesh_DongHua_TeXiao/
Redirect URLs: https://yinxiangs.github.io/BiShe_Mesh_DongHua_TeXiao/
```

本地测试时另行添加实际开发地址，例如 `http://127.0.0.1:5173/`。邮件发送需要可用的 Supabase 邮件服务；正式使用时按控制台要求配置发件服务并核对邮件限额。

老师通过分享链接直接预览与署名留言，无需创建账户。如果另有需要登录的评审员，可先在 Authentication 建立账户，再在 `review_members` 中手动授予 `reviewer`；不要给评审员 `owner`。

## 3. 部署免登录分享函数

在本网站的根目录执行 Supabase CLI。以下 `YOUR_PROJECT_REF` 是项目控制台中的项目 ID，不是网站仓库名。

```sh
npx supabase login
npx supabase secrets set REVIEW_ALLOWED_ORIGINS=https://yinxiangs.github.io,http://127.0.0.1:5173,http://localhost:5173 --project-ref YOUR_PROJECT_REF
npx supabase functions deploy review-share --project-ref YOUR_PROJECT_REF
```

仓库的 `supabase/config.toml` 为此函数设置 `verify_jwt = false`，因为老师没有登录令牌。函数仍然要求每一次请求携带有效的随机评审令牌；它只通过受限 SQL 接口读取该链接允许的项目，生成私有文件的短期签名下载地址，或提交意见。

函数使用 Supabase 运行环境提供的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。**服务端密钥只允许出现在 Edge Function 的服务器环境，禁止粘贴到网页配置、GitHub 仓库、Actions 前端构建变量或聊天消息。** 不要把 `private` 加入 Data API 的 Exposed schemas。

## 4. 配置网页

将 `public/config.example.json` 复制为 `public/config.json`，填写自己的项目地址和 **publishable key / legacy anon key**：

```json
{
  "supabaseUrl": "https://你的项目ID.supabase.co",
  "supabaseAnonKey": "你的公开publishable或anon密钥",
  "githubRepo": "YinXiangs/BiShe_Mesh_DongHua_TeXiao"
}
```

这里的公开配置会随网页被访问者读取，这是预期行为。权限由数据库、Storage 和分享函数保障。代码拒绝常见的 secret key 和 legacy service_role key。随后重新构建并部署 GitHub Pages。

## 5. 实际联测

1. 所有者用邮箱登录。创建项目，上传一个较小的 FBX（必要时连同其外部贴图）或 MP4。等待服务器保存成功，再刷新确认版本仍然存在。
2. 生成评审链接。完整链接包含 `#review=…`，复制它给老师。只发送 GitHub Pages 首页不会自动给老师授予私有项目访问权。
3. 用另一台设备或无痕窗口打开该完整链接，不登录，确认列表、FBX 旋转预览、贴图、MP4 播放和版本信息能够读取。
4. 填写署名与意见。刷新双方页面确认意见确实保存到服务器。访客署名是自行填写的，页面应标识“访客”；意见中的“通过”只是建议，不会自动把项目改成“已通过”。
5. 测试过期或撤销链接、错误令牌、向其他项目/版本提交意见均被拒绝。一个链接每分钟最多读取 60 次、提交 10 条意见；超限请一分钟后重试。

当前源码未绑定真实 Supabase 项目，也未向任何真实项目部署；本地语法、SQL 和权限模拟检查不能代替以上云端联测。

## 分享范围与失效规则

- 每次分享使用浏览器安全随机生成的 32 字节令牌，数据库只存 SHA-256 摘要。明文只在创建时返回，不写入数据库或浏览器持久存储。
- 可以分享单个项目，或整个工作室。整个工作室链接可读取现有和未来新建的项目；仅需某一项目时应使用单项目分享。
- 拿到完整链接的人可查看分享范围内的内容、下载模型并以访客署名留言，因此请仅交给需要评审的人。免登录无法证明留言者身份。
- 默认有效 30 天，创建接口允许 1 小时至 90 天。所有者可撤销链接；撤销会阻止新的数据读取和意见提交。
- 已签发的文件下载地址最长保留 15 分钟，并受链接原到期时间限制；撤销不能立即收回已下载文件或已经签发的有效地址。页面刷新会重新获取地址。
- SQL 分享函数只授权给 Edge Function 的服务端角色。匿名访问者不能拿摘要绕开函数直接调用数据库。

## 大文件与失败清理

当前使用标准上传，每次提交 1–100 个文件，代码默认单文件上限 250 MB。数据库脚本也将桶上限设为 250 MiB，但项目套餐和 Storage 全局限制可能更低，实际以控制台为准。可在公开配置添加 `maxUploadBytes` 下调前端限制；增加限制前须先调整 Storage 并确认套餐支持。

FBX/MP4 往往较大，标准上传对不稳定网络不提供断点续传。Supabase 建议超过 6 MB 使用 TUS resumable；本版本**未实现断点续传**。正式提交较大模型前，建议接入其 TUS 上传并保留当前不可覆盖的版本路径规则。页面长时间打开后，过期的签名下载会自动尝试续签一次；仍失败时可刷新评审页面。

每次上传分配全新的版本 UUID，不覆盖历史文件。文件上传或版本写入失败时，代码尝试删除该次上传路径。若数据库写入结果因断网无法确认，代码保留文件并返回待核对路径与版本 ID，以免误删已成功保存的模型。若清理也断网，错误中会列出需要所有者处理的路径。网页被强制关闭可能留下未关联文件，需在 Storage 控制台核对。

查找超过一天仍未被任何版本引用的文件（**仅列出，不会删除**）：

```sql
select o.name, o.created_at
from storage.objects o
where o.bucket_id = 'review-files'
  and o.created_at < now() - interval '1 day'
  and not exists (
    select 1 from public.versions v,
      lateral jsonb_array_elements(v.files) f
    where f->>'path' = o.name
  )
order by o.created_at;
```

核对版本是否已保存后，用 Storage 控制台或 Storage API 删除确认为孤立的对象。不要直接删除 `storage.objects` 数据行，因为那不会同步清理底层文件。

## 权限表

| 操作 | 未持链接访客 | 有效链接访客 | 已登录 reviewer | 已登录 owner |
| --- | --- | --- | --- | --- |
| 查看模型、视频、版本和意见 | 否 | 仅分享范围 | 是 | 是 |
| 新建或编辑项目 | 否 | 否 | 否 | 是 |
| 上传模型/视频版本 | 否 | 否 | 否 | 是 |
| 留言 | 否 | 自填署名，原子限频 | 自己的账户 | 自己的账户 |
| 改变项目审核状态 | 否 | 否 | 仅受限审核接口 | 是 |
| 建立/撤销分享链接 | 否 | 否 | 否 | 是 |
| 增删成员或提升角色 | 否 | 否 | 否 | 仅控制台管理员 |

已登录评审员只能通过受限 `review_asset` 接口把状态设为 `review`、`changes` 或 `approved`，不能借此修改名称、说明、类别、文件和统计数据。前端提交的 `author_id` 受 `auth.uid()` 校验；访客提交接口根本不接收 `author_id`。

## 官方依据

- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)：业务表行级权限、会员查询与避免递归。
- [Database Functions](https://supabase.com/docs/guides/database/functions)：固定 `search_path`、撤销默认执行权限、受限函数入口。
- [Private Storage Buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)：私有桶仅授权下载或短期签名访问。
- [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)：关闭 JWT 网关检查的端点必须在函数内部验证访问凭证。
- [Standard Uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads)：标准上传适用范围及 TUS 断点续传建议。
- [Storage Upload Limits](https://supabase.com/docs/guides/troubleshooting/upload-file-size-restrictions-Y4wQLT)：全局、桶和套餐限制须分别核对。
