#!/bin/zsh
# Builds "Blade Notes.app" (Apple Silicon) into build.noindex/; the suffix keeps the
# dev copy out of Spotlight. VERSION sets the version (default 0.0.0-dev);
# UPDATE_REPOSITORY (owner/repo) turns on updates from that repo's GitHub Releases;
# APP_URL is the web app it opens.
set -euo pipefail
cd "${0:A:h}"

swift build -c release --arch arm64
APP="build.noindex/Blade Notes.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --arch arm64 --show-bin-path)/BladeNotes" "$APP/Contents/MacOS/BladeNotes"
cp ../../assets/icon/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>com.mirsabbir.bladenotes</string>
    <key>CFBundleName</key><string>Blade Notes</string>
    <key>CFBundleDisplayName</key><string>Blade Notes</string>
    <key>CFBundleExecutable</key><string>BladeNotes</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0-dev}</string>
    <key>CFBundleVersion</key><string>${VERSION:-0.0.0-dev}</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>UpdateRepository</key><string>${UPDATE_REPOSITORY:-}</string>
    <key>AppURL</key><string>${APP_URL:-https://notes.mirsabbiralam.com}</string>
</dict>
</plist>
PLIST

codesign --force --sign "${SIGN_IDENTITY:--}" --identifier com.mirsabbir.bladenotes --timestamp=none "$APP"
echo "Built $APP"
