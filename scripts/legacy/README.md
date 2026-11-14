# legacy 运维脚本（源自已废弃的本地副本 sui_project_a）
这些脚本在早期开发期使用，路径常量可能指向旧血统包。仅作历史参考，
运行前先核对 scripts 内其它脚本的当前血统常量（0xcdc87b8e…）。

**注意：本目录所有脚本已加 .bak 后缀**——它们引用旧 monorepo 布局的 `../packages/sdk`（主仓不存在该路径），编译会失败；使用前先恢复后缀并把导入路径改到 `packages/multisig`。
