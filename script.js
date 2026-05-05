// DOCS Web Interaction Script

document.addEventListener('DOMContentLoaded', () => {
    // 1. Navbar Scroll Effect
    const navbar = document.getElementById('navbar');
    
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    // 2. Mobile Menu Toggle
    const mobileBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');
    
    if(mobileBtn) {
        mobileBtn.addEventListener('click', () => {
            // Aquí podríamos agregar una clase 'active' para mostrar el menú en móvil
            // Por simplicidad, togglamos un estilo inline o clase
            navLinks.style.display = navLinks.style.display === 'flex' ? 'none' : 'flex';
            navLinks.style.flexDirection = 'column';
            navLinks.style.position = 'absolute';
            navLinks.style.top = '80px';
            navLinks.style.left = '0';
            navLinks.style.width = '100%';
            navLinks.style.background = 'rgba(5,5,5,0.95)';
            navLinks.style.padding = '2rem';
        });
    }

    // 3. Smooth Scrolling for Navigation Links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            if(targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if(targetElement) {
                // Adjust for navbar height
                const navHeight = navbar.offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.pageYOffset - navHeight;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
                
                // Hide mobile menu if open
                if(window.innerWidth <= 900 && navLinks.style.display === 'flex') {
                    navLinks.style.display = 'none';
                }
            }
        });
    });

    // 3.5 ScrollSpy - Update active link on scroll
    const sections = document.querySelectorAll('header[id], section[id]');
    const navItems = document.querySelectorAll('.nav-link');

    const observerOptions = {
        root: null,
        rootMargin: '-20% 0px -80% 0px', // Adjust this to trigger when section is in top part of viewport
        threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const currentId = entry.target.getAttribute('id');
                
                navItems.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === `#${currentId}`) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }, observerOptions);

    sections.forEach(section => observer.observe(section));


    // 4. Form Submission Handling (Conexión al Backend Node.js)
    const paymentForm = document.getElementById('paymentForm');
    if(paymentForm) {
        paymentForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = paymentForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.innerText;
            
            submitBtn.innerText = 'Enviando Verificación...';
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.7';

            try {
                // Crear FormData para enviar la foto y los datos
                const formData = new FormData();
                formData.append('name', document.getElementById('name').value);
                formData.append('email', document.getElementById('email').value);
                formData.append('cedula', document.getElementById('cedula').value);
                formData.append('phone', document.getElementById('phone').value);
                formData.append('bank', document.getElementById('bank').value);
                formData.append('ref', document.getElementById('ref').value);
                formData.append('ticketCount', document.getElementById('ticketCount').value);
                
                // Extraer el total en Bs sin el texto html adicional
                const totalBsText = document.getElementById('monto-bs').innerText.split('(')[0].trim();
                formData.append('totalBs', totalBsText);
                
                const fileInput = document.getElementById('receipt');
                if (fileInput.files.length > 0) {
                    formData.append('receipt', fileInput.files[0]);
                }

                // Enviar al Backend (puerto 3000)
                const response = await fetch('http://192.168.0.101:3000/api/tickets/request', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();

                if (response.ok) {
                    alert('¡Comprobante enviado! En breve verificaremos tu pago y recibirás tu entrada en tu correo.');
                    paymentForm.reset();
                    closePaymentModal();
                } else {
                    alert('Error: ' + (result.error || 'No se pudo enviar la verificación.'));
                }
            } catch (error) {
                console.error(error);
                alert('Error de conexión con el servidor.');
            } finally {
                submitBtn.innerText = originalText;
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
        });
    }

    // 5. Fetch BCV Rate (EUR)
    const montoBsElement = document.getElementById('monto-bs');
    const ticketCountInput = document.getElementById('ticketCount');
    const ticketPriceEUR = 15;
    let currentRateEUR = 0;

    async function fetchBCVRate() {
        try {
            const response = await fetch('https://ve.dolarapi.com/v1/euros/oficial');
            const data = await response.json();
            if (data && data.promedio) {
                currentRateEUR = data.promedio;
                updateTotal();
            } else {
                if(montoBsElement) montoBsElement.innerText = "Error al cargar tasa (Consultar en IG)";
            }
        } catch (error) {
            console.error('Error fetching BCV rate:', error);
            if(montoBsElement) montoBsElement.innerText = "Error al cargar tasa (Consultar en IG)";
        }
    }

    function updateTotal() {
        if (currentRateEUR > 0 && montoBsElement) {
            const count = parseInt(ticketCountInput ? ticketCountInput.value : 1) || 1;
            const totalBs = (currentRateEUR * ticketPriceEUR * count).toFixed(2);
            montoBsElement.innerHTML = `Bs. ${totalBs} <span style="font-size:0.75rem; color:var(--text-secondary); font-weight:normal;">(Tasa BCV EUR: Bs. ${currentRateEUR})</span>`;
        }
    }

    if (montoBsElement) {
        fetchBCVRate();
        if (ticketCountInput) {
            ticketCountInput.addEventListener('input', updateTotal);
        }
    }
});

// Modal Functions (Global scope to be called from HTML onClick)
function openPaymentModal() {
    const modal = document.getElementById('paymentModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
}

function closePaymentModal() {
    const modal = document.getElementById('paymentModal');
    modal.classList.remove('active');
    document.body.style.overflow = ''; // Restore scrolling
}

// Close modal when clicking outside the content
window.addEventListener('click', (event) => {
    const modal = document.getElementById('paymentModal');
    if (event.target === modal) {
        closePaymentModal();
    }
});
