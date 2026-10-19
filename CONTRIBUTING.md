# 🤝 Contributing to CodaiPro

Thank you for your interest in contributing to CodaiPro! This document provides guidelines and information for contributors.

> **Building the Windows desktop app?** Read [WINDOWS_HANDOFF.md](WINDOWS_HANDOFF.md) first. It explains the build steps, the architecture, and the environment variables, and is written to be understood without prior context.

## 🌟 Ways to Contribute

### 🐛 Bug Reports
- Report bugs through [GitHub Issues](https://github.com/luckyyaduvanshi/codaipro/issues)
- Include detailed reproduction steps
- Provide system information and screenshots

### 💡 Feature Requests
- Suggest new features via [GitHub Issues](https://github.com/luckyyaduvanshi/codaipro/issues)
- Explain the use case and benefits
- Discuss implementation approaches

### 🔧 Code Contributions
- Fix bugs and implement features
- Improve documentation
- Optimize performance
- Add tests

### 📖 Documentation
- Improve README and guides
- Write tutorials and examples
- Translate to other languages
- Create video tutorials

## 🚀 Getting Started

### 1. Fork the Repository
```bash
# Click "Fork" on GitHub
# Clone your fork
git clone https://github.com/YOUR_USERNAME/codaipro.git
cd codaipro
```

### 2. Set Up Development Environment
```bash
# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

### 3. Create Feature Branch
```bash
git checkout -b feature/your-feature-name
# or
git checkout -b bugfix/issue-number
```

## 📝 Development Guidelines

### Code Style
- Follow PEP 8 for Python code
- Use meaningful variable and function names
- Add docstrings for functions and classes
- Keep functions small and focused

### Commit Messages
```bash
# Format: type(scope): description
feat(ui): add dark mode toggle
fix(backend): resolve memory leak in AI engine
docs(readme): update installation instructions
test(core): add unit tests for launcher
```

### Testing
```bash
# Python tests
python -m pytest tests/ -q

# Desktop tests
cd desktop
npm ci --include=dev
npm test

# Run from source
python dev/controller.py

# Windows launcher + cleanup (portable build)
run.bat
kill.bat
```

## 🔄 Pull Request Process

### 1. Before Submitting
- [ ] Code follows style guidelines
- [ ] Tests pass locally
- [ ] Documentation updated if needed
- [ ] No merge conflicts with main branch

### 2. Pull Request Template
```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Performance improvement

## Testing
- [ ] Tested locally
- [ ] Added/updated tests
- [ ] Build process works

## Screenshots (if applicable)
Add screenshots for UI changes
```

### 3. Review Process
1. Automated checks run
2. Code review by maintainers
3. Address feedback if needed
4. Merge when approved

## 🏗️ Project Structure

```
CodaiPro/
├── dev/                      # Python controller (config, engine, proxy, system)
├── desktop/                  # Electron desktop app (main, preload, renderer)
├── ui/                       # Browser chat UI (portable build)
├── engine/                   # llama-server binary (not in git)
├── models/                   # GGUF models (not in git)
├── config.json               # Runtime configuration
├── run.bat / kill.bat        # Portable launcher / cleanup
├── Codai.spec                # PyInstaller packaging
├── build-windows.ps1         # One-command Windows build
├── website/                  # Public site (GitHub Pages)
├── docs/                     # Architecture docs and diagrams
└── .github/workflows/        # Release + Pages automation
```

## 🎯 Priority Areas

### High Priority
- **Performance optimization** for low-spec machines
- **Memory usage reduction** for lab environments
- **UI/UX improvements** for better user experience
- **Bug fixes** for stability issues

### Medium Priority
- **New AI features** and capabilities
- **Additional language support**
- **Cross-platform compatibility**
- **Plugin system** for extensions

### Low Priority
- **Advanced customization** options
- **Integration** with other tools
- **Advanced analytics** and metrics

## 🧪 Testing Guidelines

### Manual Testing
1. **Single Instance**: Test multiple launch attempts
2. **AI Functionality**: Verify code generation works
3. **UI Responsiveness**: Check all buttons and menus
4. **Exit Behavior**: Ensure clean shutdown

### Automated Testing
```bash
# Unit tests
python -m pytest tests/unit/

# Integration tests
python -m pytest tests/integration/

# Build tests
python -m pytest tests/build/
```

## 📋 Issue Labels

| Label | Description |
|-------|-------------|
| `bug` | Something isn't working |
| `enhancement` | New feature or request |
| `documentation` | Improvements to docs |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention needed |
| `priority: high` | Critical issues |
| `priority: low` | Nice to have |

## 🎓 For Students

### Easy Contributions
- **Documentation improvements**
- **Bug reports** with detailed steps
- **Feature suggestions** based on lab experience
- **Screenshots** and examples

### Learning Opportunities
- **Python systems programming** with process supervision and HTTP proxying
- **Local AI integration** with llama.cpp (`llama-server`)
- **Vanilla JS UI engineering** for low-end hardware
- **DevOps practices** with GitHub Actions

## 🏆 Recognition

### Contributors
All contributors are recognized in:
- **README.md** contributors section
- **Release notes** for their contributions
- **GitHub contributors** page

### Special Recognition
- **Top contributors** get special badges
- **Feature contributors** get mentioned in releases
- **Documentation contributors** get highlighted

## 📞 Getting Help

### Development Questions
- **GitHub Discussions**: [Ask questions](https://github.com/luckyyaduvanshi/codaipro/discussions)
- **Issues**: [Technical problems](https://github.com/luckyyaduvanshi/codaipro/issues)

### Direct Contact
- **Portfolio**: [luckyyaduvanshiofficial.github.io](https://luckyyaduvanshiofficial.github.io)
- **GitHub**: [@luckyyaduvanshi](https://github.com/luckyyaduvanshi)

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to CodaiPro! Together, we're making AI-powered coding accessible to students everywhere! 🚀**