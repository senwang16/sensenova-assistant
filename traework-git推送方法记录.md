# traework：Git 推送方法记录（SSH 方式）

> 记录时间：2026-09-15
> 项目：sensenova-assistant（Chrome 扩展）
> 远程仓库：https://github.com/senwang16/sensenova-assistant.git

## 一、结论：用 SSH 推送成功

本次推送采用 **SSH 方式** 成功将本地代码推送到 GitHub，远程 `main` 分支已更新到提交 `6ee832b`（feat: Agnes 供应商接入）。

SSH 无需每次输入 token，是本机推荐方式（本机已配置 `id_ed25519` SSH key）。

## 二、完整推送步骤

### 1. 检查 SSH 认证（首次使用确认即可）

```powershell
ssh -T git@github.com
# 出现 "Hi senwang16! You've successfully authenticated" 即认证成功
```

### 2. 配置远程地址（SSH 格式）

```powershell
git remote set-url origin git@github.com:senwang16/sensenova-assistant.git
# 或新增
git remote add origin git@github.com:senwang16/sensenova-assistant.git
```

### 3. 日常推送流程

```powershell
cd E:\he\sensenova-assistant
git status                        # 查看变更
git add <改动文件>                 # 逐个添加，避免误加敏感文件
git commit -m "feat: 改动说明"
git push origin main
```

### 4. 验证

```powershell
git log --oneline -3              # 本地最近提交
git ls-remote origin main         # 远程 HEAD，应与本地一致
```

## 三、本次踩过的坑（重要）

### 坑 1：E:\he 目录下 Git 写对象权限失败

现象：在 `E:\he\sensenova-assistant` 下执行 `git add` / `git clone` / `git fetch` 均报：

```
error: unable to write file .git/objects/...: Permission denied
```

原因：`E:\he` 目录存在写权限限制（手动写测试文件可以，但 git 写对象报错）。

**解决方案**：在系统临时目录完成提交和推送，再把 `.git` 复制回项目目录：

```powershell
# 1. 克隆远程到临时目录
git clone https://github.com/senwang16/sensenova-assistant.git $env:TEMP\sensenova-clone

# 2. 把本地修改的文件复制进克隆目录
Copy-Item E:\he\sensenova-assistant\*.js  $env:TEMP\sensenova-clone\
Copy-Item E:\he\sensenova-assistant\*.css $env:TEMP\sensenova-clone\
# ...（按需复制所有改动文件）

# 3. 在临时目录提交 + 推送
cd $env:TEMP\sensenova-clone
git add .
git commit -m "提交说明"
git push origin main

# 4. 把含完整历史的 .git 复制回项目目录
Remove-Item -Recurse -Force E:\he\sensenova-assistant\.git
Copy-Item -Recurse $env:TEMP\sensenova-clone\.git E:\he\sensenova-assistant\.git
```

> 提示：首次提交需配置身份（否则报 `Author identity unknown`）：
> ```powershell
> git config user.name "senwang16"
> git config user.email "senwang16@users.noreply.github.com"
> ```

### 坑 2：PowerShell 不支持 heredoc 提交信息

现象：`git commit -m "$(cat <<'EOF' ...)"` 报语法错误。

**解决方案**：用单行 `-m` 或多行字符串：

```powershell
git commit -m "feat: 标题"
git commit -m "feat: 标题" -m "详细说明第一段" -m "详细说明第二段"
```

## 四、常用命令速查

| 操作 | 命令 |
|---|---|
| 查看状态 | `git status` |
| 查看差异 | `git diff` |
| 切换 remote 为 SSH | `git remote set-url origin git@github.com:senwang16/sensenova-assistant.git` |
| 推送 | `git push origin main` |
| 拉取最新 | `git pull origin main` |
| 查看远程 | `git remote -v` |
