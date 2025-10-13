# PyInstaller runtime hook for transformers
# This patches transformers to work in frozen PyInstaller apps

import os
import sys

# Disable transformers' lazy loading and backend checks
os.environ['TRANSFORMERS_OFFLINE'] = '0'
os.environ['USE_TF'] = 'NO'
os.environ['USE_TORCH'] = 'NO'
os.environ['USE_FLAX'] = 'NO'

print("[PyInstaller Hook] Pre-importing critical transformers modules...")

# Pre-import modules that are problematic with lazy loading
try:
    # Import the actual config modules before transformers tries to lazy-load them
    import transformers.models.encoder_decoder.configuration_encoder_decoder
    import transformers.configuration_utils
    print("[PyInstaller Hook] Pre-imported encoder_decoder configuration")
except Exception as e:
    print(f"[PyInstaller Hook] Warning: Could not pre-import configs: {e}")

# Patch transformers' file system scanning
def patch_transformers():
    """Patch transformers to disable file system scanning"""
    try:
        import transformers.utils.import_utils as import_utils
        
        # Save original function
        original_create_import_structure_from_path = import_utils.create_import_structure_from_path
        
        def patched_create_import_structure_from_path(path):
            """Return empty structure to disable file scanning"""
            return {}
        
        # Apply the patch
        import_utils.create_import_structure_from_path = patched_create_import_structure_from_path
        
        print("[PyInstaller Hook] Successfully patched transformers file scanning")
        return True
    except Exception as e:
        print(f"[PyInstaller Hook] Warning: Could not patch transformers: {e}")
        return False

# Apply patch
patch_transformers()

print("[PyInstaller Hook] Configured transformers for frozen environment")

