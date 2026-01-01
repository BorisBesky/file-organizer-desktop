#!/usr/bin/env node

/**
 * Bumps the version in package.json and syncs to all config files
 * Usage: npm run version:bump <major|minor|patch|version>
 * Examples:
 *   npm run version:bump patch     -> 1.0.0 -> 1.0.1
 *   npm run version:bump minor     -> 1.0.0 -> 1.1.0
 *   npm run version:bump major     -> 1.0.0 -> 2.0.0
 *   npm run version:bump 1.2.3     -> 1.2.3
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected: major.minor.patch`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

function formatVersion(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(type) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const currentVersion = packageJson.version;

    if (!currentVersion) {
      console.error('❌ No version found in package.json');
      process.exit(1);
    }

    let newVersion;

    if (type === 'major' || type === 'minor' || type === 'patch') {
      const parsed = parseVersion(currentVersion);
      
      if (type === 'major') {
        newVersion = formatVersion(parsed.major + 1, 0, 0);
      } else if (type === 'minor') {
        newVersion = formatVersion(parsed.major, parsed.minor + 1, 0);
      } else if (type === 'patch') {
        newVersion = formatVersion(parsed.major, parsed.minor, parsed.patch + 1);
      }
    } else {
      // Assume it's a specific version string
      parseVersion(type); // Validate format
      newVersion = type;
    }

    console.log(`📦 Bumping version: ${currentVersion} -> ${newVersion}`);

    // Update package.json
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    console.log('✅ Updated package.json');

    // Sync to other files
    console.log('\n🔄 Syncing version to other files...');
    execSync('node scripts/sync-version.cjs', { stdio: 'inherit', cwd: rootDir });

    // Create git tag
    console.log(`\n🏷️  Creating git tag: app-v${newVersion}`);
    try {
      execSync(`git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`, { cwd: rootDir });
      execSync(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: rootDir });
      execSync(`git tag app-v${newVersion}`, { cwd: rootDir });
      console.log(`✅ Created git tag: app-v${newVersion}`);
      console.log('\n📌 Push tags with: git push && git push --tags');
    } catch (error) {
      console.warn('⚠️  Could not create git commit/tag. Make sure git is initialized and you have changes to commit.');
      console.warn('   You can manually tag this version later with: git tag app-v' + newVersion);
    }

    console.log(`\n✨ Version bump complete: ${newVersion}`);
  } catch (error) {
    console.error('❌ Error bumping version:', error.message);
    process.exit(1);
  }
}

// Get bump type from command line args
const bumpType = process.argv[2];

if (!bumpType) {
  console.error('❌ Usage: npm run version:bump <major|minor|patch|version>');
  console.error('   Examples:');
  console.error('     npm run version:bump patch');
  console.error('     npm run version:bump minor');
  console.error('     npm run version:bump major');
  console.error('     npm run version:bump 1.2.3');
  process.exit(1);
}

bumpVersion(bumpType);
