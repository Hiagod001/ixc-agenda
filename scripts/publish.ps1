param(
    [Parameter(Mandatory = $true)]
    [string]$Message
)

$branch = git branch --show-current
if (-not $branch) {
    Write-Error "Nao foi possivel identificar a branch atual."
    exit 1
}

git add .
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Output "Nao ha alteracoes prontas para commit."
    exit 0
}

git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

git push -u origin $branch
exit $LASTEXITCODE
