import os
import json
from datetime import datetime
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

app = Flask(__name__)

# Security configurations
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'lockscribe-dev-secret-key-change-in-production')

# Dynamic Database URI (Render PostgreSQL support with SQLite fallback)
database_url = os.environ.get('DATABASE_URL', 'sqlite:///lockscribe.db')
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'
login_manager.login_message = "Please log in to access your LockScribe Vault."
login_manager.login_message_category = "info"

# Web Push VAPID Configurations
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_CLAIMS = {"sub": "mailto:admin@lockscribe.com"}

# ----------------- Database Models -----------------

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # Relationships
    notes = db.relationship('Note', backref='author', lazy=True, cascade="all, delete-orphan")
    push_subscriptions = db.relationship('PushSubscription', backref='user', lazy=True, cascade="all, delete-orphan")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Note(db.Model):
    __tablename__ = 'notes'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    
    # Store zero-knowledge client-side encrypted payloads
    encrypted_title = db.Column(db.Text, default="")
    encrypted_content = db.Column(db.Text, default="")
    
    # State & Organization flags
    is_favorite = db.Column(db.Boolean, default=False)
    is_archived = db.Column(db.Boolean, default=False)
    is_trashed = db.Column(db.Boolean, default=False)
    reminder_at = db.Column(db.DateTime, nullable=True)
    reminder_msg = db.Column(db.String(255), default="")
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'encrypted_title': self.encrypted_title,
            'encrypted_content': self.encrypted_content,
            'is_favorite': self.is_favorite,
            'is_archived': self.is_archived,
            'is_trashed': self.is_trashed,
            'reminder_at': self.reminder_at.strftime('%Y-%m-%dT%H:%M') if self.reminder_at else None,
            'reminder_msg': self.reminder_msg or "",
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': self.updated_at.strftime('%d %b %Y, %H:%M')
        }


class PushSubscription(db.Model):
    __tablename__ = 'push_subscriptions'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    subscription_info = db.Column(db.Text, nullable=False)


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))

# Auto-create tables for both Gunicorn (Render) and local environments
with app.app_context():
    db.create_all()

# ----------------- Background Reminder Worker -----------------

def check_reminders():
    with app.app_context():
        now = datetime.utcnow()
        due_notes = Note.query.filter(
            Note.reminder_at.isnot(None),
            Note.reminder_at <= now,
            Note.is_trashed == False
        ).all()

        for note in due_notes:
            subs = PushSubscription.query.filter_by(user_id=note.user_id).all()
            for sub in subs:
                try:
                    webpush(
                        subscription_info=json.loads(sub.subscription_info),
                        data=json.dumps({
                            "title": "LockScribe Reminder",
                            "body": note.reminder_msg or "Reminder alert from your encrypted note."
                        }),
                        vapid_private_key=VAPID_PRIVATE_KEY,
                        vapid_claims=VAPID_CLAIMS
                    )
                except WebPushException as ex:
                    # Stale subscription endpoint removal
                    if ex.response and ex.response.status_code in [404, 410]:
                        db.session.delete(sub)
                except Exception:
                    pass

            note.reminder_at = None
            db.session.commit()

# APScheduler init (checks database every 60 seconds)
scheduler = BackgroundScheduler()
scheduler.add_job(func=check_reminders, trigger="interval", seconds=60)
scheduler.start()

# ----------------- Frontend Page Routes -----------------

@app.route('/')
@login_required
def index():
    return render_template('index.html', username=current_user.username)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))

    if request.method == 'POST':
        identifier = request.form.get('identifier', '').strip()
        password = request.form.get('password', '')

        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()

        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for('index'))
        else:
            flash('Invalid username/email or password.', 'error')

    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')

        if not username or not email or not password:
            flash('All fields are required.', 'error')
            return render_template('register.html')

        if User.query.filter_by(username=username).first():
            flash('Username is already taken.', 'error')
            return render_template('register.html')

        if User.query.filter_by(email=email).first():
            flash('Email is already registered.', 'error')
            return render_template('register.html')

        new_user = User(username=username, email=email)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()

        flash('Registration successful! Please log in.', 'success')
        return redirect(url_for('login'))

    return render_template('register.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    flash('You have been logged out securely.', 'info')
    return redirect(url_for('login'))

# ----------------- Secure REST API Endpoints -----------------

@app.route('/api/vapid-key', methods=['GET'])
@login_required
def get_vapid_key():
    return jsonify({'publicKey': VAPID_PUBLIC_KEY})


@app.route('/api/subscribe', methods=['POST'])
@login_required
def subscribe():
    sub_data = request.get_json()
    if not sub_data:
        return jsonify({'error': 'Invalid payload'}), 400

    sub_str = json.dumps(sub_data)
    exists = PushSubscription.query.filter_by(user_id=current_user.id, subscription_info=sub_str).first()
    if not exists:
        db.session.add(PushSubscription(user_id=current_user.id, subscription_info=sub_str))
        db.session.commit()

    return jsonify({'status': 'subscribed'}), 201


@app.route('/api/notes', methods=['GET', 'POST'])
@login_required
def api_notes():
    if request.method == 'GET':
        category = request.args.get('filter', 'all')
        query = Note.query.filter_by(user_id=current_user.id)

        if category == 'favorites':
            query = query.filter_by(is_favorite=True, is_trashed=False)
        elif category == 'reminders':
            query = query.filter(Note.reminder_at.isnot(None), Note.is_trashed == False)
        elif category == 'archive':
            query = query.filter_by(is_archived=True, is_trashed=False)
        elif category == 'trash':
            query = query.filter_by(is_trashed=True)
        else:
            query = query.filter_by(is_trashed=False, is_archived=False)

        notes = query.order_by(Note.updated_at.desc()).all()
        return jsonify([note.to_dict() for note in notes])

    if request.method == 'POST':
        data = request.get_json() or {}
        reminder_at = None
        if data.get('reminder_at'):
            try:
                reminder_at = datetime.fromisoformat(data['reminder_at'])
            except (ValueError, TypeError):
                try:
                    reminder_at = datetime.strptime(data['reminder_at'], '%Y-%m-%dT%H:%M')
                except Exception:
                    reminder_at = None

        new_note = Note(
            user_id=current_user.id,
            encrypted_title=data.get('encrypted_title', ''),
            encrypted_content=data.get('encrypted_content', ''),
            reminder_at=reminder_at,
            reminder_msg=data.get('reminder_msg', '')
        )
        db.session.add(new_note)
        db.session.commit()
        return jsonify(new_note.to_dict()), 201


@app.route('/api/notes/<int:note_id>', methods=['GET', 'PUT', 'DELETE'])
@login_required
def api_note_detail(note_id):
    note = Note.query.filter_by(id=note_id, user_id=current_user.id).first()
    if not note:
        return jsonify({'error': 'Note not found or unauthorized access'}), 404

    if request.method == 'GET':
        return jsonify(note.to_dict())

    if request.method == 'PUT':
        data = request.get_json() or {}
        if 'encrypted_title' in data:
            note.encrypted_title = data['encrypted_title']
        if 'encrypted_content' in data:
            note.encrypted_content = data['encrypted_content']
        if 'is_favorite' in data:
            note.is_favorite = bool(data['is_favorite'])
        if 'is_archived' in data:
            note.is_archived = bool(data['is_archived'])
        if 'is_trashed' in data:
            note.is_trashed = bool(data['is_trashed'])
        if 'reminder_msg' in data:
            note.reminder_msg = data.get('reminder_msg', '') or ''
        if 'reminder_at' in data:
            reminder_val = data.get('reminder_at')
            if reminder_val:
                try:
                    note.reminder_at = datetime.fromisoformat(reminder_val)
                except (ValueError, TypeError):
                    try:
                        note.reminder_at = datetime.strptime(reminder_val, '%Y-%m-%dT%H:%M')
                    except Exception:
                        note.reminder_at = None
            else:
                note.reminder_at = None
                if 'reminder_msg' not in data:
                    note.reminder_msg = ""

        note.updated_at = datetime.utcnow()
        db.session.commit()
        return jsonify(note.to_dict())

    if request.method == 'DELETE':
        db.session.delete(note)
        db.session.commit()
        return jsonify({'message': 'Note permanently deleted', 'id': note_id})


if __name__ == '__main__':
    app.run(debug=True, port=5000)