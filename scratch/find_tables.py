with open('chetana/UI WORKING/src/App.jsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if "setStep('dashboard')" in line or 'setStep("dashboard")' in line:
        print(f'{idx+1}: {line.strip()}')
