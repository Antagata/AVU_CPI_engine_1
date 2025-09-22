# GitHub Repository Setup Instructions

## Step 1: Create Repository on GitHub

1. Go to https://github.com/new
2. Repository name: `avu-cpi-webapp` (or your preferred name)
3. Description: `AVU CPI Campaign Management WebApp`
4. Set to **Private** (recommended for business project)
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click "Create repository"

## Step 2: Connect Local Repository to GitHub

After creating the repository on GitHub, you'll see a page with setup instructions.
Copy the HTTPS URL (it will look like: https://github.com/Antagata/avu-cpi-webapp.git)

Then run these commands in your terminal:

```powershell
# Add the remote repository (replace with your actual repo URL)
git remote add origin https://github.com/Antagata/avu-cpi-webapp.git

# Push your code to GitHub
git push -u origin main
```

## Step 3: Verify Upload

After pushing, you should see all your files on GitHub at:
https://github.com/Antagata/avu-cpi-webapp

## Alternative: If you prefer SSH

If you have SSH keys set up with GitHub:
```powershell
git remote add origin git@github.com:Antagata/avu-cpi-webapp.git
git push -u origin main
```

## Troubleshooting

If you get authentication errors:
1. Make sure you're logged into GitHub in your browser
2. You may need to create a Personal Access Token if using HTTPS
3. Or set up SSH keys for easier authentication

The repository is now ready to be safely moved to another computer!