#!/bin/bash
set -e

echo "🗑️  正在清理旧数据..."
rm -rf backend/data
echo "✅ 数据已清理，下次启动将重新生成带演示数据的新数据库"
