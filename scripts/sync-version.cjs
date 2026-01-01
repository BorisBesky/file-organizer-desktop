#!/usr/bin/env node

/**
 * Syncs version from package.json to Cargo.toml and tauri.conf.json
 * This ensures a single source of truth for version management
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

function syncVersion() {
  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version;

    if (!version) {
      console.error('❌ No version found in package.json');
      process.exit(1);
    }

    console.log(`📦 Syncing version: ${version}`);

    // Update Cargo.toml
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const cargoVersionRegex = /^version = ".*"$/m;
    
    if (!cargoVersionRegex.test(cargoToml)) {
      console.error('❌ Could not find version field in Cargo.toml');
      process.exit(1);
    }

    cargoToml = cargoToml.replace(cargoVersionRegex, `version = "${version}"`);
    fs.writeFileSync(cargoTomlPath, cargoToml, 'utf8');
    console.log('✅ Updated Cargo.toml');

    // Update tauri.conf.json
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    
    if (!tauriConf.package) {
      console.error('❌ No package field in tauri.conf.json');
      process.exit(1);
    }

    tauriConf.package.version = version;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
    console.log('✅ Updated tauri.conf.json');

    console.log(`\n✨ Version ${version} synced successfully!`);
  } catch (error) {
    console.error('❌ Error syncing version:', error.message);
    process.exit(1);
  }
}

syncVersion();
